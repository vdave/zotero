#!/bin/bash
CWD="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

case "$(uname -s)" in
   CYGWIN*) IS_CYGWIN=1 ;;
esac

function makePath {
	local __assignTo=$1
	local __path=$2
	if [ ! -z $IS_CYGWIN ]; then
		__path="`cygpath -aw \"$__path\"`"
	fi
	eval $__assignTo="'$__path'"
}

if [ -z "$FX_EXECUTABLE" ]; then
	if [ "`uname`" == "Darwin" ]; then
		FX_EXECUTABLE="/Applications/Firefox Unbranded.app/Contents/MacOS/firefox"
	else
		FX_EXECUTABLE="firefox"
	fi
fi

if [ -z "$DISPLAY" ]; then
	FX_ARGS=""
else
	FX_ARGS="--class=ZTestFirefox"
fi

function usage {
	cat >&2 <<DONE
Usage: $0 [option] [TESTS...]
Options
 -b                  skip bundled translator/style installation
 -c                  open JavaScript console and don't quit on completion
 -d LEVEL            enable debug logging
 -f                  stop after first test failure
 -g                  only run tests matching the given pattern (grep)
 -h                  display this help
 -t                  generate test data and quit
 -x FX_EXECUTABLE    path to Firefox executable (default: $FX_EXECUTABLE)
 TESTS               set of tests to run (default: all)
DONE
	exit 1
}

DEBUG=false
DEBUG_LEVEL=5
while getopts "bcd:fg:htx:" opt; do
	case $opt in
        b)
        	FX_ARGS="$FX_ARGS -ZoteroSkipBundledFiles"
        	;;
		c)
			FX_ARGS="$FX_ARGS -jsconsole -noquit"
			;;
		d)
			DEBUG=true
			DEBUG_LEVEL="$OPTARG"
			;;
		f)
			FX_ARGS="$FX_ARGS -bail"
			;;
		g)
			GREP="$OPTARG"
			;;
		h)
			usage
			;;
		t)
			FX_ARGS="$FX_ARGS -makeTestData"
			;;
		x)
			FX_EXECUTABLE="$OPTARG"
			;;
		*)
			usage
			;;
	esac
	shift $((OPTIND-1)); OPTIND=1
done

if [ -z $1 ]; then
	TESTS="all"
else
	ARGS=("${@:1}")
	function join { local IFS="$1"; shift; echo "$*"; }
	TESTS="$(join , "${ARGS[@]}")"
fi

# Increase open files limit
#
# Mozilla file functions (OS.File.move()/copy(), NetUtil.asyncFetch/asyncCopy()) can leave file
# descriptors open for a few seconds (even with an explicit inputStream.close() in the case of
# the latter), so a source installation that copies ~500 translators and styles (with fds for
# source and target) can exceed the default 1024 limit.
ulimit -n 4096

# Set up profile directory
TEMPDIR="`mktemp -d 2>/dev/null || mktemp -d -t 'zotero-unit'`"
PROFILE="$TEMPDIR/profile"
mkdir -p "$PROFILE/extensions"

makePath ZOTERO_UNIT_PATH "$CWD"
echo "$ZOTERO_UNIT_PATH" > "$PROFILE/extensions/zotero-unit@zotero.org"

makePath ZOTERO_PATH "`dirname "$CWD"`"
echo "$ZOTERO_PATH" > "$PROFILE/extensions/zotero@chnm.gmu.edu"

# Create data directory
mkdir "$TEMPDIR/Zotero"

cat <<EOF > "$PROFILE/prefs.js"
user_pref("extensions.autoDisableScopes", 0);
user_pref("browser.uitour.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("extensions.zotero.debug.log", $DEBUG);
user_pref("extensions.zotero.debug.level", $DEBUG_LEVEL);
user_pref("extensions.zotero.debug.time", $DEBUG);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.reportTranslationFailure", false);
user_pref("extensions.zotero.httpServer.enabled", true);
user_pref("extensions.zotero.backup.numBackups", 0);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("xpinstall.signatures.required", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.healthreport.service.enabled", false);
user_pref("datareporting.healthreport.service.firstRun", false);
EOF

# -v flag on Windows makes Firefox process hang
if [ -z $IS_CYGWIN ]; then
	echo "`MOZ_NO_REMOTE=1 NO_EM_RESTART=1 \"$FX_EXECUTABLE\" -v`"
fi

if [ "$TRAVIS" = true ]; then
	FX_ARGS="$FX_ARGS -ZoteroAutomatedTest -ZoteroTestTimeout 10000"
fi

# Clean up on exit
trap "{ rm -rf \"$TEMPDIR\"; }" EXIT

makePath FX_PROFILE "$PROFILE"
MOZ_NO_REMOTE=1 NO_EM_RESTART=1 "$FX_EXECUTABLE" -profile "$FX_PROFILE" \
    -chrome chrome://zotero-unit/content/runtests.html -test "$TESTS" -grep "$GREP" -ZoteroTest $FX_ARGS

# Check for success
test -e "$PROFILE/success"
STATUS=$?

exit $STATUS