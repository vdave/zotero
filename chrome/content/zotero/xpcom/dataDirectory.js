/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2016 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

"use strict";

Zotero.DataDirectory = {
	MIGRATION_MARKER: 'migrate-dir',
	
	get dir() {
		if (!this._dir) {
			throw new Error("Data directory not initialized");
		}
		return this._dir;
	},
	
	get defaultDir() {
		// Use special data directory for tests
		if (Zotero.test) {
			return OS.Path.join(OS.Path.dirname(OS.Constants.Path.profileDir), "Zotero");
		}
		return OS.Path.join(OS.Constants.Path.homeDir, ZOTERO_CONFIG.CLIENT_NAME);
	},
	
	get legacyDirName() {
		return ZOTERO_CONFIG.ID;
	},
	
	_dir: null,
	_warnOnUnsafeLocation: true,
	
	
	init: Zotero.Promise.coroutine(function* () {
		var file;
		if (Zotero.Prefs.get('useDataDir')) {
			let prefVal = Zotero.Prefs.get('dataDir');
			// Convert old persistent descriptor pref to string path and clear obsolete lastDataDir pref
			//
			// persistentDescriptor now appears to return (and parse) a string path anyway on macOS,
			// which is the only place where it didn't use a string path to begin with, but be explicit
			// just in case there's some difference.
			//
			// A post-Mozilla prefs migration should do this same check, and then this conditional can
			// be removed.
			if (Zotero.Prefs.get('lastDataDir')) {
				let nsIFile;
				try {
					nsIFile = Components.classes["@mozilla.org/file/local;1"]
						.createInstance(Components.interfaces.nsILocalFile);
					nsIFile.persistentDescriptor = prefVal;
				}
				catch (e) {
					Zotero.debug("Persistent descriptor in extensions.zotero.dataDir did not resolve", 1);
					e = { name: "NS_ERROR_FILE_NOT_FOUND" };
					throw e;
				}
				// This removes lastDataDir
				this.set(nsIFile.path);
				file = nsIFile.path;
			}
			else {
				// If there's a migration marker in this directory and no database, migration was
				// interrupted before the database could be moved (or moving failed), so use the source
				// directory specified in the marker file.
				let migrationMarker = OS.Path.join(prefVal, this.MIGRATION_MARKER);
				let dbFile = OS.Path.join(prefVal, this.getDatabaseFilename());
				if ((yield OS.File.exists(migrationMarker)) && !(OS.File.exists(dbFile))) {
					let contents = yield Zotero.File.getContentsAsync(migrationMarker);
					try {
						let { sourceDir } = JSON.parse(contents);
						file = OS.Path.normalize(sourceDir);
					}
					catch (e) {
						Zotero.logError(e);
						Zotero.debug(`Invalid marker file:\n\n${contents}`, 1);
						e = { name: "NS_ERROR_FILE_NOT_FOUND" };
						throw e;
					}
				}
				else {
					try {
						file = OS.Path.normalize(prefVal);
					}
					catch (e) {
						Zotero.logError(e);
						Zotero.debug(`Invalid path '${prefVal}' in dataDir pref`, 1);
						e = { name: "NS_ERROR_FILE_NOT_FOUND" };
						throw e;
					}
				}
			}
			
			if (!(yield OS.File.exists(file)) && file != this.defaultDir) {
				// If set to a legacy directory that doesn't exist, forget about it and just use the
				// new default location, which will either exist or be created below. The most likely
				// cause of this is a migration, so don't bother looking in other-app profiles.
				if (this.isLegacy(file)) {
					let newDefault = this.defaultDir;
					Zotero.debug(`Legacy data directory ${file} from pref not found `
						+ `-- reverting to ${newDefault}`, 1);
					file = newDefault;
					this.set(newDefault);
				}
				// For other custom directories that don't exist, show not-found dialog
				else {
					Zotero.debug("Custom data directory ${file} not found", 1);
					throw { name: "NS_ERROR_FILE_NOT_FOUND" };
				}
			}
		}
		else {
			let dataDir = this.defaultDir;
			
			//
			// TODO: asyncify
			//
			
			// Check for ~/Zotero/zotero.sqlite
			let dbFile = OS.Path.join(dataDir, this.getDatabaseFilename());
			if (yield OS.File.exists(dbFile)) {
				Zotero.debug("Using data directory " + dataDir);
				this._cache(dataDir);
				
				// Set as a custom data directory so that 4.0 uses it
				this.set(dataDir);
				
				return dataDir;
			}
			
			// Check for 'zotero' dir in profile dir
			let profileSubdir = OS.Path.join(Zotero.Profile.dir, this.legacyDirName);
			if (yield OS.File.exists(profileSubdir)) {
				Zotero.debug("Using data directory " + profileSubdir);
				this._cache(profileSubdir);
				return profileSubdir;
			}
			
			//
			// If Standalone and no directory yet, check Firefox directory, or vice versa
			//
			let profilesParent = OS.Path.dirname(Zotero.Profile.getOtherAppProfilesDir());
			Zotero.debug("Looking for existing profile in " + profilesParent);
			
			// get default profile
			var defProfile;
			try {
				defProfile = yield Zotero.Profile.getDefaultInProfilesDir(profilesParent);
			} catch(e) {
				Zotero.debug("An error occurred locating the Firefox profile; not "+
					"attempting to migrate from Zotero for Firefox");
				Zotero.logError(e);
			}
			
			if(defProfile) {
				// get Zotero directory
				let profileDir = defProfile[0].path;
				Zotero.debug("Found default profile at " + profileDir);
				
				// copy prefs
				let prefsFile = OS.Path.join(profileDir, "prefs.js");
				if (yield OS.File.exists(prefsFile)) {
					// build sandbox
					var sandbox = new Components.utils.Sandbox("http://www.example.com/");
					Components.utils.evalInSandbox(
						"var prefs = {};"+
						"function user_pref(key, val) {"+
							"prefs[key] = val;"+
						"}"
					, sandbox);
					
					// remove comments
					var prefsJs = yield Zotero.File.getContentsAsync(prefsFile);
					prefsJs = prefsJs.replace(/^#[^\r\n]*$/mg, "");
					
					// evaluate
					Components.utils.evalInSandbox(prefsJs, sandbox);
					var prefs = sandbox.prefs;
					for(var key in prefs) {
						if(key.substr(0, ZOTERO_CONFIG.PREF_BRANCH.length) === ZOTERO_CONFIG.PREF_BRANCH
								&& key !== "extensions.zotero.firstRun2") {
							Zotero.Prefs.set(key.substr(ZOTERO_CONFIG.PREF_BRANCH.length), prefs[key]);
						}
					}
					
					// If data directory setting was transferred, use that
					if (Zotero.Prefs.get('useDataDir')) {
						return this.init();
					}
				}
				
				// If there's a data directory in the default profile for the alternative app, use that
				let zoteroDir = OS.Path.join(profileDir, this.legacyDirName);
				if (yield OS.File.exists(zoteroDir)) {
					this.set(zoteroDir);
					file = zoteroDir;
				}
			}
			
			if (!file) {
				file = dataDir;
			}
		}
		
		Zotero.debug("Using data directory " + file);
		yield Zotero.File.createDirectoryIfMissingAsync(file);
		this._cache(file);
	}),
	
	
	_cache: function (dir) {
		this._dir = dir;
	},
	
	
	/**
	 * @return {Boolean} - True if the directory changed; false otherwise
	 */
	set: function (path) {
		var origPath = Zotero.Prefs.get('dataDir');
		
		Zotero.Prefs.set('dataDir', path);
		// Clear legacy pref
		Zotero.Prefs.clear('lastDataDir');
		Zotero.Prefs.set('useDataDir', true);
		
		return path != origPath;
	},
	
	
	choose: Zotero.Promise.coroutine(function* (forceQuitNow, useHomeDir, moreInfoCallback) {
		var win = Services.wm.getMostRecentWindow('navigator:browser');
		var ps = Services.prompt;
		
		if (useHomeDir) {
			let changed = this.set(this.defaultDir);
			if (!changed) {
				return false;
			}
		}
		else {
			var nsIFilePicker = Components.interfaces.nsIFilePicker;
			while (true) {
				var fp = Components.classes["@mozilla.org/filepicker;1"]
							.createInstance(nsIFilePicker);
				fp.init(win, Zotero.getString('dataDir.selectDir'), nsIFilePicker.modeGetFolder);
				fp.displayDirectory = Zotero.File.pathToFile(this.dir);
				fp.appendFilters(nsIFilePicker.filterAll);
				if (fp.show() == nsIFilePicker.returnOK) {
					var file = fp.file;
					let dialogText = '';
					let dialogTitle = '';
					
					if (file.path == (Zotero.Prefs.get('lastDataDir') || Zotero.Prefs.get('dataDir'))) {
						Zotero.debug("Data directory hasn't changed");
						return false;
					}
					
					// In dropbox folder
					if (Zotero.File.isDropboxDirectory(file.path)) {
						dialogTitle = Zotero.getString('general.warning');
						dialogText = Zotero.getString('dataDir.unsafeLocation.selected.dropbox') + "\n\n"
								+ Zotero.getString('dataDir.unsafeLocation.selected.useAnyway');
					}
					else if (file.directoryEntries.hasMoreElements()) {
						let dbfile = file.clone();
						dbfile.append(this.getDatabaseFilename());
						
						// Warn if non-empty and no zotero.sqlite
						if (!dbfile.exists()) {
							dialogTitle = Zotero.getString('dataDir.selectedDirNonEmpty.title');
							dialogText = Zotero.getString('dataDir.selectedDirNonEmpty.text');
						}
					}
					// Directory empty
					else {
						dialogTitle = Zotero.getString('dataDir.selectedDirEmpty.title');
						dialogText = Zotero.getString('dataDir.selectedDirEmpty.text', Zotero.appName) + '\n\n'
								+ Zotero.getString('dataDir.selectedDirEmpty.useNewDir');
					}
					// Warning dialog to be displayed
					if(dialogText !== '') {
						let buttonFlags = ps.STD_YES_NO_BUTTONS;
						if (moreInfoCallback) {
							buttonFlags += ps.BUTTON_POS_2 * ps.BUTTON_TITLE_IS_STRING;
						}
						let index = ps.confirmEx(null,
							dialogTitle,
							dialogText,
							buttonFlags,
							null,
							null,
							moreInfoCallback ? Zotero.getString('general.moreInformation') : null,
							null, {});

						// Not OK -- return to file picker
						if (index == 1) {
							continue;
						}
						else if (index == 2) {
							setTimeout(function () {
								moreInfoCallback();
							}, 1);
							return false;
						}
					}

					this.set(file.path);
					
					break;
				}
				else {
					return false;
				}
			}
		}
		
		var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING);
		if (!forceQuitNow) {
			buttonFlags += (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_IS_STRING);
		}
		var app = Zotero.appName;
		var index = ps.confirmEx(null,
			Zotero.getString('general.restartRequired'),
			Zotero.getString('general.restartRequiredForChange', app)
				+ "\n\n" + Zotero.getString('dataDir.moveFilesToNewLocation', app),
			buttonFlags,
			Zotero.getString('general.quitApp', app),
			forceQuitNow ? null : Zotero.getString('general.restartLater'),
			null, null, {});
		
		if (forceQuitNow || index == 0) {
			Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
		}
		
		return useHomeDir ? true : file;
	}),
	
	
	forceChange: function (win) {
		if (!win) {
			win = Services.wm.getMostRecentWindow('navigator:browser');
		}
		var ps = Services.prompt;
		
		var nsIFilePicker = Components.interfaces.nsIFilePicker;
		while (true) {
			var fp = Components.classes["@mozilla.org/filepicker;1"]
						.createInstance(nsIFilePicker);
			fp.init(win, Zotero.getString('dataDir.selectNewDir', Zotero.clientName), nsIFilePicker.modeGetFolder);
			fp.displayDirectory = Zotero.File.pathToFile(this.dir);
			fp.appendFilters(nsIFilePicker.filterAll);
			if (fp.show() == nsIFilePicker.returnOK) {
				var file = fp.file;
				
				if (file.directoryEntries.hasMoreElements()) {
					ps.alert(null,
						Zotero.getString('dataDir.mustSelectEmpty.title'),
						Zotero.getString('dataDir.mustSelectEmpty.text')
					);
					continue;
				}
				
				this.set(file.path);
				
				return file;
			} else {
				return false;
			}
		}
	},
	
	
	checkForUnsafeLocation: Zotero.Promise.coroutine(function* (path) {
		if (this._warnOnUnsafeLocation && Zotero.File.isDropboxDirectory(path)
				&& Zotero.Prefs.get('warnOnUnsafeDataDir')) {
			this._warnOnUnsafeLocation = false;
			let check = {value: false};
			let index = Services.prompt.confirmEx(
				null,
				Zotero.getString('general.warning'),
				Zotero.getString('dataDir.unsafeLocation.existing.dropbox') + "\n\n"
					+ Zotero.getString('dataDir.unsafeLocation.existing.chooseDifferent'),
				Services.prompt.STD_YES_NO_BUTTONS,
				null, null, null,
				Zotero.getString('general.dontShowWarningAgain'),
				check
			);

			// Yes - display dialog.
			if (index == 0) {
				yield this.choose(true);
			}
			if (check.value) {
				Zotero.Prefs.set('warnOnUnsafeDataDir', false);
			}
		}
	}),
	
	
	isLegacy: function (dir) {
		// 'zotero'
		return OS.Path.basename(dir) == this.legacyDirName
				// '69pmactz.default'
				&& OS.Path.basename(OS.Path.dirname(dir)).match(/^[0-9a-z]{8}\..+/)
				// 'Profiles'
				&& OS.Path.basename(OS.Path.dirname(OS.Path.dirname(dir))) == 'Profiles';
	},
	
	
	/**
	 * Determine if current data directory is in a legacy location
	 */
	canMigrate: function () {
		// If (not default location) && (not useDataDir or within legacy location)
		var currentDir = this.dir;
		if (currentDir == this.defaultDir) {
			return false;
		}
		
		// Legacy default or set to legacy default from other program (Standalone/Z4Fx) to share data
		if (!Zotero.Prefs.get('useDataDir') || this.isLegacy(currentDir)) {
			return true;
		}
		
		return false;
	},
	
	
	reveal: function () {
		return Zotero.File.reveal(this.dir);
	},
	
	
	markForMigration: function (dir, automatic = false) {
		return Zotero.File.putContentsAsync(
			OS.Path.join(dir, this.MIGRATION_MARKER),
			JSON.stringify({
				sourceDir: dir,
				automatic
			})
		);
	},
	
	
	/**
	 * Migrate data directory if necessary and show any errors
	 *
	 * @param {String} dataDir - Current directory
	 * @param {String} targetDir - Target directory, which may be the same; except in tests, this is
	 *     the default data directory
	 */
	checkForMigration: Zotero.Promise.coroutine(function* (dataDir, newDir) {
		if (!this.canMigrate(dataDir)) {
			return false;
		}
		
		let migrationMarker = OS.Path.join(dataDir, this.MIGRATION_MARKER);
		try {
			var exists = yield OS.File.exists(migrationMarker)
		}
		catch (e) {
			Zotero.logError(e);
		}
		let automatic = false;
		if (!exists) {
			// Migrate automatically on macOS and Linux -- this should match the check in
			// Zotero.File.moveDirectory()
			if (!Zotero.isWin && (yield OS.File.exists("/bin/mv"))) {
				automatic = true;
			}
			else {
				return false;
			}
			
			// Skip automatic migration if there's a non-empty directory at the new location
			if ((yield OS.File.exists(newDir)) && !(yield Zotero.File.directoryIsEmpty(newDir))) {
				Zotero.debug(`${newDir} exists and is non-empty -- skipping migration`);
				return false;
			}
		}
		
		// Check for an existing pipe from other running versions of Zotero pointing at the same data
		// directory, and skip migration if found
		try {
			let foundPipe = yield Zotero.IPC.pipeExists();
			if (foundPipe) {
				Zotero.debug("Found existing pipe -- skipping migration");
				return false;
			}
		}
		catch (e) {
			Zotero.logError("Error checking for pipe -- skipping migration:\n\n" + e);
			return false;
		}
		
		// If there are other profiles pointing to the old directory, make sure we can edit the prefs.js
		// file before doing anything, or else we risk orphaning a 4.0 installation
		try {
			let otherProfiles = yield Zotero.Profile.findOtherProfilesUsingDataDirectory(dataDir);
			// 'touch' each prefs.js file to make sure we can access it
			for (let dir of otherProfiles) {
				let prefs = OS.Path.join(dir, "prefs.js");
				yield OS.File.setDates(prefs);
			}
		}
		catch (e) {
			Zotero.logError(e);
			Zotero.logError("Error checking other profiles -- skipping migration");
			// TODO: After 5.0 has been out a while, remove this and let migration continue even if
			// other profile directories can't be altered, with the assumption that they'll be running
			// 5.0 already and will be pick up the new data directory automatically.
			return false;
		}
		
		if (automatic) {
			yield this.markForMigration(dataDir, true);
		}
		
		let sourceDir;
		let oldDir;
		let partial = false;
		
		// Check whether this is an automatic or manual migration
		let contents;
		try {
			contents = yield Zotero.File.getContentsAsync(migrationMarker);
			({ sourceDir, automatic } = JSON.parse(contents));
		}
		catch (e) {
			if (contents !== undefined) {
				Zotero.debug(contents, 1);
			}
			Zotero.logError(e);
			return false;
		}
		
		// Not set to the default directory, so use current as old directory
		if (dataDir != newDir) {
			oldDir = dataDir;
		}
		// Unfinished migration -- already using new directory, so get path to previous
		// directory from the migration marker
		else {
			oldDir = sourceDir;
			partial = true;
		}
		
		// Not yet used
		let progressHandler = function (progress, progressMax) {
			this.updateZoteroPaneProgressMeter(Math.round(progress / progressMax));
		}.bind(this);
		
		let errors;
		let mode = automatic ? 'automatic' : 'manual';
		// This can seemingly fail due to a race condition building the Standalone window,
		// so just ignore it if it does
		try {
			Zotero.showZoteroPaneProgressMeter(Zotero.getString("dataDir.migration.inProgress"));
		}
		catch (e) {
			Zotero.logError(e);
		}
		try {
			errors = yield this.migrate(oldDir, newDir, partial, progressHandler);
		}
		catch (e) {
			// Complete failure (failed to create new directory, copy marker, or move database)
			Zotero.debug("Migration failed", 1);
			Zotero.logError(e);
			
			let ps = Services.prompt;
			let buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
				+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_IS_STRING);
			let index = ps.confirmEx(null,
				Zotero.getString('dataDir.migration.failure.title'),
				Zotero.getString(`dataDir.migration.failure.full.${mode}.text1`, ZOTERO_CONFIG.CLIENT_NAME)
					+ "\n\n"
					+ e
					+ "\n\n"
					+ Zotero.getString(`dataDir.migration.failure.full.${mode}.text2`, Zotero.appName)
					+ "\n\n"
					+ Zotero.getString('dataDir.migration.failure.full.current', oldDir)
					+ "\n\n"
					+ Zotero.getString('dataDir.migration.failure.full.recommended', newDir),
				buttonFlags,
				Zotero.getString('dataDir.migration.failure.full.showCurrentDirectoryAndQuit', Zotero.appName),
				Zotero.getString('general.notNow'),
				null, null, {}
			);
			if (index == 0) {
				yield Zotero.File.reveal(oldDir);
				Zotero.skipLoading = true;
				Zotero.Utilities.Internal.quitZotero();
			}
			return;
		}
		
		// Set data directory again
		Zotero.debug("Using new data directory " + newDir);
		this._cache(newDir);
		// Tell Zotero for Firefox in connector mode to reload and find the new data directory
		if (Zotero.isStandalone) {
			Zotero.IPC.broadcast('reinit');
		}
		
		// At least the database was copied, but other things failed
		if (errors.length) {
			let ps = Services.prompt;
			let buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
				+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_IS_STRING)
				+ (ps.BUTTON_POS_2) * (ps.BUTTON_TITLE_IS_STRING);
			let index = ps.confirmEx(null,
				Zotero.getString('dataDir.migration.failure.title'),
				Zotero.getString(`dataDir.migration.failure.partial.${mode}.text`,
						[ZOTERO_CONFIG.CLIENT_NAME, Zotero.appName])
					+ "\n\n"
					+ Zotero.getString('dataDir.migration.failure.partial.old', oldDir)
					+ "\n\n"
					+ Zotero.getString('dataDir.migration.failure.partial.new', newDir),
				buttonFlags,
				Zotero.getString('general.tryAgain'),
				Zotero.getString('general.tryLater'),
				Zotero.getString('dataDir.migration.failure.partial.showDirectoriesAndQuit', Zotero.appName),
				null, {}
			);
			
			if (index == 0) {
				return this.checkForMigration(newDir, newDir);
			}
			// Focus the first file/folder in the old directory
			else if (index == 2) {
				try {
					let it = new OS.File.DirectoryIterator(oldDir);
					let entry;
					try {
						entry = yield it.next();
					}
					catch (e) {
						if (e != StopIteration) {
							throw e;
						}
					}
					finally {
						it.close();
					}
					if (entry) {
						yield Zotero.File.reveal(entry.path);
					}
					// Focus the database file in the new directory
					yield Zotero.File.reveal(OS.Path.join(newDir, this.getDatabaseFilename()));
				}
				catch (e) {
					Zotero.logError(e);
				}
				
				Zotero.skipLoading = true;
				Zotero.Utilities.Internal.quitZotero();
				return;
			}
		}
	}),
	
	
	/**
	 * Recursively moves data directory from one location to another and updates the data directory
	 * setting in this profile and any profiles pointing to the old location
	 *
	 * If moving the database file fails, an error is thrown.
	 * Otherwise, an array of errors is returned.
	 *
	 * @param {String} oldDir
	 * @param {String} newDir
	 * @return {Error[]}
	 */
	migrate: Zotero.Promise.coroutine(function* (oldDir, newDir, partial) {
		var dbName = this.getDatabaseFilename();
		var errors = [];
		
		function addError(e) {
			errors.push(e);
			Zotero.logError(e);
		}
		
		if (!(yield OS.File.exists(oldDir))) {
			Zotero.debug(`Old directory ${oldDir} doesn't exist -- nothing to migrate`);
			try {
				let newMigrationMarker = OS.Path.join(newDir, this.MIGRATION_MARKER);
				Zotero.debug("Removing " + newMigrationMarker);
				yield OS.File.remove(newMigrationMarker);
			}
			catch (e) {
				Zotero.logError(e);
			}
			return [];
		}
		
		if (partial) {
			Zotero.debug(`Continuing data directory migration from ${oldDir} to ${newDir}`);
		}
		else {
			Zotero.debug(`Migrating data directory from ${oldDir} to ${newDir}`);
		}
		
		// Create the new directory
		if (!partial) {
			try {
				yield OS.File.makeDir(
					newDir,
					{
						ignoreExisting: false,
						unixMode: 0o755
					}
				);
			}
			catch (e) {
				// If default dir exists and is non-empty, move it out of the way
				// ("Zotero-1", "Zotero-2", …)
				if (e instanceof OS.File.Error && e.becauseExists) {
					if (!(yield Zotero.File.directoryIsEmpty(newDir))) {
						let i = 1;
						while (true) {
							let backupDir = newDir + "-" + i++;
							if (yield OS.File.exists(backupDir)) {
								if (i > 5) {
									throw new Error("Too many backup directories "
										+ "-- stopped at " + backupDir);
								}
								continue;
							}
							Zotero.debug(`Moving existing directory to ${backupDir}`);
							yield Zotero.File.moveDirectory(newDir, backupDir);
							break;
						}
						yield OS.File.makeDir(
							newDir,
							{
								ignoreExisting: false,
								unixMode: 0o755
							}
						);
					}
				}
				else {
					throw e;
				}
			}
		}
		
		// Copy marker
		let oldMarkerFile = OS.Path.join(oldDir, this.MIGRATION_MARKER);
		// Marker won't exist on subsequent attempts after partial failure
		if (yield OS.File.exists(oldMarkerFile)) {
			yield OS.File.copy(oldMarkerFile, OS.Path.join(newDir, this.MIGRATION_MARKER));
		}
		
		// Update the data directory setting first. If moving the database fails, get() will continue
		// to use the old directory based on the migration marker
		this.set(newDir);
		
		// Move database
		if (!partial) {
			Zotero.debug("Moving " + dbName);
			yield OS.File.move(OS.Path.join(oldDir, dbName), OS.Path.join(newDir, dbName));
		}
		
		// Once the database has been moved, we can clear the migration marker from the old directory.
		// If the migration is interrupted after this, it can be continued later based on the migration
		// marker in the new directory.
		try {
			yield OS.File.remove(OS.Path.join(oldDir, this.MIGRATION_MARKER));
		}
		catch (e) {
			addError(e);
		}
		
		errors = errors.concat(yield Zotero.File.moveDirectory(
			oldDir,
			newDir,
			{
				allowExistingTarget: true,
				// Don't overwrite root files (except for hidden files like .DS_Store)
				noOverwrite: path => {
					return OS.Path.dirname(path) == oldDir && !OS.Path.basename(path).startsWith('.')
				},
			}
		));
		
		if (errors.length) {
			Zotero.logError("Not all files were transferred from " + oldDir + " to " + newDir);
		}
		else {
			try {
				let newMigrationMarker = OS.Path.join(newDir, this.MIGRATION_MARKER);
				Zotero.debug("Removing " + newMigrationMarker);
				yield OS.File.remove(newMigrationMarker);
				
				Zotero.debug("Migration successful");
			}
			catch (e) {
				addError(e);
			}
		}
		
		// Update setting in other profiles that point to this data directory
		try {
			let otherProfiles = yield Zotero.Profile.findOtherProfilesUsingDataDirectory(oldDir);
			for (let dir of otherProfiles) {
				try {
					yield Zotero.Profile.updateProfileDataDirectory(dir, oldDir, newDir);
				}
				catch (e) {
					Zotero.logError("Error updating " + OS.Path.join(dir.path, "prefs.js"));
					Zotero.logError(e);
				}
			}
		}
		catch (e) {
			Zotero.logError("Error updating other profiles to point to new location");
		}
		
		return errors;
	}),
	
	
	getDatabaseFilename: function (name) {
		return (name || ZOTERO_CONFIG.ID) + '.sqlite';
	},
	
	getDatabase: function (name, ext) {
		name = this.getDatabaseFilename(name);
		ext = ext ? '.' + ext : '';
		
		return OS.Path.join(this.dir, name + ext);
	}
};
