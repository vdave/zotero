/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2006–2013 Center for History and New Media
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

Zotero_Preferences.Advanced = {
	_openURLResolvers: null,
	
	
	init: function () {
		Zotero_Preferences.Debug_Output.init();
		Zotero_Preferences.Keys.init();
		
		this.onDataDirLoad();
	},
	
	
	migrateDataDirectory: Zotero.Promise.coroutine(function* () {
		var currentDir = Zotero.DataDirectory.dir;
		var defaultDir = Zotero.DataDirectory.defaultDir;
		if (currentDir == defaultDir) {
			Zotero.debug("Already using default directory");
			return;
		}
		
		Components.utils.import("resource://zotero/config.js")
		var ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
			.getService(Components.interfaces.nsIPromptService);
		var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
					+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL);
		var index = ps.confirmEx(window,
			Zotero.getString('zotero.preferences.advanced.migrateDataDir.title'),
			Zotero.getString(
				'zotero.preferences.advanced.migrateDataDir.directoryWillBeMoved',
				[ZOTERO_CONFIG.CLIENT_NAME, defaultDir]
			) + '\n\n'
			+ Zotero.getString(
				'zotero.preferences.advanced.migrateDataDir.appMustBeRestarted', Zotero.appName
			),
			buttonFlags,
			Zotero.getString('general.restartApp', Zotero.appName),
			null, null, null, {}
		);
		
		if (index == 0) {
			yield Zotero.DataDirectory.markForMigration(currentDir);
			Zotero.Utilities.Internal.quitZotero(true);
		}
	}),
	
	
	runIntegrityCheck: Zotero.Promise.coroutine(function* () {
		var ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
			.getService(Components.interfaces.nsIPromptService);
		
		var ok = yield Zotero.DB.integrityCheck();
		if (ok) {
			ok = yield Zotero.Schema.integrityCheck();
			if (!ok) {
				var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
					+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL);
				var index = ps.confirmEx(window,
					Zotero.getString('general.failed'),
					Zotero.getString('db.integrityCheck.failed') + "\n\n" +
						Zotero.getString('db.integrityCheck.repairAttempt') + " " +
						Zotero.getString('db.integrityCheck.appRestartNeeded', Zotero.appName),
					buttonFlags,
					Zotero.getString('db.integrityCheck.fixAndRestart', Zotero.appName),
					null, null, null, {}
				);
				
				if (index == 0) {
					// Safety first
					yield Zotero.DB.backupDatabase();
					
					// Fix the errors
					yield Zotero.Schema.integrityCheck(true);
					
					// And run the check again
					ok = yield Zotero.Schema.integrityCheck();
					var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING);
					if (ok) {
						var str = 'success';
						var msg = Zotero.getString('db.integrityCheck.errorsFixed');
					}
					else {
						var str = 'failed';
						var msg = Zotero.getString('db.integrityCheck.errorsNotFixed')
									+ "\n\n" + Zotero.getString('db.integrityCheck.reportInForums');
					}
					
					ps.confirmEx(window,
						Zotero.getString('general.' + str),
						msg,
						buttonFlags,
						Zotero.getString('general.restartApp', Zotero.appName),
						null, null, null, {}
					);
					
					var appStartup = Components.classes["@mozilla.org/toolkit/app-startup;1"]
							.getService(Components.interfaces.nsIAppStartup);
					appStartup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit
						| Components.interfaces.nsIAppStartup.eRestart);
				}
				
				return;
			}
		}
		var str = ok ? 'passed' : 'failed';
		
		ps.alert(window,
			Zotero.getString('general.' + str),
			Zotero.getString('db.integrityCheck.' + str)
			+ (!ok ? "\n\n" + Zotero.getString('db.integrityCheck.dbRepairTool') : ''));
	}),
	
	
	resetTranslatorsAndStyles: function () {
		var ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
			.getService(Components.interfaces.nsIPromptService);
		
		var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
			+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL);
		
		var index = ps.confirmEx(null,
			Zotero.getString('general.warning'),
			Zotero.getString('zotero.preferences.advanced.resetTranslatorsAndStyles.changesLost'),
			buttonFlags,
			Zotero.getString('zotero.preferences.advanced.resetTranslatorsAndStyles'),
			null, null, null, {});
		
		if (index == 0) {
			Zotero.Schema.resetTranslatorsAndStyles()
			.then(function () {
				if (Zotero_Preferences.Export) {
					Zotero_Preferences.Export.populateQuickCopyList();
				}
			});
		}
	},
	
	
	resetTranslators: function () {
		var ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
			.getService(Components.interfaces.nsIPromptService);
		
		var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
			+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL);
		
		var index = ps.confirmEx(null,
			Zotero.getString('general.warning'),
			Zotero.getString('zotero.preferences.advanced.resetTranslators.changesLost'),
			buttonFlags,
			Zotero.getString('zotero.preferences.advanced.resetTranslators'),
			null, null, null, {});
		
		if (index == 0) {
			Zotero.Schema.resetTranslators()
			.then(function () {
				if (Zotero_Preferences.Export) {
					Zotero_Preferences.Export.populateQuickCopyList();
				}
			});
		}
	},
	
	
	resetStyles: function () {
		var ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
			.getService(Components.interfaces.nsIPromptService);
		
		var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
			+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL);
		
		var index = ps.confirmEx(null,
			Zotero.getString('general.warning'),
			Zotero.getString('zotero.preferences.advanced.resetStyles.changesLost'),
			buttonFlags,
			Zotero.getString('zotero.preferences.advanced.resetStyles'),
			null, null, null, {});
		
		if (index == 0) {
			Zotero.Schema.resetStyles()
			.then(function () {
				if (Zotero_Preferences.Export) {
					Zotero_Preferences.Export.populateQuickCopyList();
				}
			});
		}
	},
	
	
	onDataDirLoad: function () {
		var useDataDir = Zotero.Prefs.get('useDataDir');
		var dataDir = Zotero.Prefs.get('lastDataDir') || Zotero.Prefs.get('dataDir');
		var currentDir = Zotero.DataDirectory.dir;
		var defaultDataDir = Zotero.DataDirectory.defaultDir;
		
		// Change "Use profile directory" label to home directory location unless using profile dir
		if (useDataDir || currentDir == defaultDataDir) {
			document.getElementById('default-data-dir').setAttribute(
				'label', Zotero.getString('dataDir.default', Zotero.DataDirectory.defaultDir)
			);
		}
		
		// Don't show custom data dir as in-use if set to the default
		if (dataDir == defaultDataDir) {
			useDataDir = false;
		}
		
		document.getElementById('data-dir-path').setAttribute('disabled', !useDataDir);
		document.getElementById('migrate-data-dir').setAttribute(
			'hidden', !Zotero.DataDirectory.canMigrate()
		);
		
		return useDataDir;
	},
	
	
	onDataDirUpdate: Zotero.Promise.coroutine(function* (event) {
		var radiogroup = document.getElementById('data-dir');
		var useDataDir = Zotero.Prefs.get('useDataDir');
		var newUseDataDir = radiogroup.selectedIndex == 1;
		
		if (newUseDataDir && !this._usingDefaultDataDir()) {
			return;
		}
		
		// This call shows a filepicker if needed, forces a restart if required, and does nothing if
		// cancel was pressed or value hasn't changed
		yield Zotero.DataDirectory.choose(
			true,
			!newUseDataDir,
			() => Zotero_Preferences.openURL('https://zotero.org/support/zotero_data')
		);
		radiogroup.selectedIndex = this._usingDefaultDataDir() ? 0 : 1;
	}),
	
	
	chooseDataDir: function(event) {
		document.getElementById('data-dir').selectedIndex = 1;
		//this.onDataDirUpdate(event);
	},
	
	
	getDataDirPath: function () {
		// TEMP: lastDataDir can be removed once old persistent descriptors have been
		// converted, which they are in getZoteroDirectory() in 5.0
		var prefValue = Zotero.Prefs.get('lastDataDir') || Zotero.Prefs.get('dataDir');
		
		// Don't show path if the default
		if (prefValue == Zotero.DataDirectory.defaultDir) {
			return '';
		}
		
		return prefValue || '';
	},
	
	
	_usingDefaultDataDir: function () {
		// Legacy profile directory location
		if (!Zotero.Prefs.get('useDataDir')) {
			return true;
		}
		
		var dataDir = Zotero.Prefs.get('lastDataDir') || Zotero.Prefs.get('dataDir');
		// Default home directory location
		if (dataDir == Zotero.DataDirectory.defaultDir) {
			return true;
		}
		
		return false;
	},
	
	
	populateOpenURLResolvers: function () {
		var openURLMenu = document.getElementById('openURLMenu');
		
		this._openURLResolvers = Zotero.OpenURL.discoverResolvers();
		var i = 0;
		for (let r of this._openURLResolvers) {
			openURLMenu.insertItemAt(i, r.name);
			if (r.url == Zotero.Prefs.get('openURL.resolver') && r.version == Zotero.Prefs.get('openURL.version')) {
				openURLMenu.selectedIndex = i;
			}
			i++;
		}
		
		var button = document.getElementById('openURLSearchButton');
		switch (this._openURLResolvers.length) {
			case 0:
				var num = 'zero';
				break;
			case 1:
				var num = 'singular';
				break;
			default:
				var num = 'plural';
		}
		
		button.setAttribute('label', Zotero.getString('zotero.preferences.openurl.resolversFound.' + num, this._openURLResolvers.length));
	},
	
	
	onOpenURLSelected: function () {
		var openURLServerField = document.getElementById('openURLServerField');
		var openURLVersionMenu = document.getElementById('openURLVersionMenu');
		var openURLMenu = document.getElementById('openURLMenu');
		
		if(openURLMenu.value == "custom")
		{
			openURLServerField.focus();
		}
		else
		{
			openURLServerField.value = this._openURLResolvers[openURLMenu.selectedIndex]['url'];
			openURLVersionMenu.value = this._openURLResolvers[openURLMenu.selectedIndex]['version'];
			Zotero.Prefs.set("openURL.resolver", this._openURLResolvers[openURLMenu.selectedIndex]['url']);
			Zotero.Prefs.set("openURL.version", this._openURLResolvers[openURLMenu.selectedIndex]['version']);
		}
	},
	
	onOpenURLCustomized: function () {
		document.getElementById('openURLMenu').value = "custom";
	}
};


Zotero_Preferences.Attachment_Base_Directory = {
	getPath: function () {
		var oldPath = Zotero.Prefs.get('baseAttachmentPath');
		if (oldPath) {
			try {
				return OS.Path.normalize(oldPath);
			}
			catch (e) {
				Zotero.logError(e);
				return false;
			}
		}
	},
	
	
	choosePath: Zotero.Promise.coroutine(function* () {
		var oldPath = this.getPath();
		
		//Prompt user to choose new base path
		if (oldPath) {
			var oldPathFile = Zotero.File.pathToFile(oldPath);
		}
		var nsIFilePicker = Components.interfaces.nsIFilePicker;
		var fp = Components.classes["@mozilla.org/filepicker;1"]
					.createInstance(nsIFilePicker);
		if (oldPathFile) {
			fp.displayDirectory = oldPathFile;
		}
		fp.init(window, Zotero.getString('attachmentBasePath.selectDir'), nsIFilePicker.modeGetFolder);
		fp.appendFilters(nsIFilePicker.filterAll);
		if (fp.show() != nsIFilePicker.returnOK) {
			return false;
		}
		var newPath = OS.Path.normalize(fp.file.path);
		
		if (oldPath && oldPath == newPath) {
			Zotero.debug("Base directory hasn't changed");
			return false;
		}
		
		return this.changePath(newPath);
	}),
	
	
	changePath: Zotero.Promise.coroutine(function* (basePath) {
		// Find all current attachments with relative attachment paths
		var sql = "SELECT itemID FROM itemAttachments WHERE linkMode=? AND path LIKE ?";
		var params = [
			Zotero.Attachments.LINK_MODE_LINKED_FILE,
			Zotero.Attachments.BASE_PATH_PLACEHOLDER + "%"
		];
		var oldRelativeAttachmentIDs = yield Zotero.DB.columnQueryAsync(sql, params);
		
		//Find all attachments on the new base path
		var sql = "SELECT itemID FROM itemAttachments WHERE linkMode=?";
		var params = [Zotero.Attachments.LINK_MODE_LINKED_FILE];
		var allAttachments = yield Zotero.DB.columnQueryAsync(sql, params);
		var newAttachmentPaths = {};
		var numNewAttachments = 0;
		var numOldAttachments = 0;
		for (let i=0; i<allAttachments.length; i++) {
			let attachmentID = allAttachments[i];
			let attachmentPath;
			let relPath = false
			
			try {
				let attachment = yield Zotero.Items.getAsync(attachmentID);
				// This will return FALSE for relative paths if base directory
				// isn't currently set
				attachmentPath = attachment.getFilePath();
				// Get existing relative path
				let storedPath = attachment.attachmentPath;
				if (storedPath.startsWith(Zotero.Attachments.BASE_PATH_PLACEHOLDER)) {
					relPath = storedPath.substr(Zotero.Attachments.BASE_PATH_PLACEHOLDER.length);
				}
			}
			catch (e) {
				// Don't deal with bad attachment paths. Just skip them.
				Zotero.debug(e, 2);
				continue;
			}
			
			// If a file with the same relative path exists within the new base directory,
			// don't touch the attachment, since it will continue to work
			if (relPath) {
				if (yield OS.File.exists(OS.Path.join(basePath, relPath))) {
					numNewAttachments++;
					continue;
				}
			}
			
			// Files within the new base directory need to be updated to use
			// relative paths (or, if the new base directory is an ancestor or
			// descendant of the old one, new relative paths)
			if (attachmentPath && Zotero.File.directoryContains(basePath, attachmentPath)) {
				newAttachmentPaths[attachmentID] = relPath ? attachmentPath : null;
				numNewAttachments++;
			}
			// Existing relative attachments not within the new base directory
			// will be converted to absolute paths
			else if (relPath && this.getPath()) {
				newAttachmentPaths[attachmentID] = attachmentPath;
				numOldAttachments++;
			}
		}
		
		//Confirm change of the base path
		var ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
			.getService(Components.interfaces.nsIPromptService);
		
		var chooseStrPrefix = 'attachmentBasePath.chooseNewPath.';
		var clearStrPrefix = 'attachmentBasePath.clearBasePath.';
		var title = Zotero.getString(chooseStrPrefix + 'title');
		var msg1 = Zotero.getString(chooseStrPrefix + 'message') + "\n\n", msg2 = "", msg3 = "";
		switch (numNewAttachments) {
			case 0:
				break;
			
			case 1:
				msg2 += Zotero.getString(chooseStrPrefix + 'existingAttachments.singular') + " ";
				break;
			
			default:
				msg2 += Zotero.getString(chooseStrPrefix + 'existingAttachments.plural', numNewAttachments) + " ";
		}
		
		switch (numOldAttachments) {
			case 0:
				break;
			
			case 1:
				msg3 += Zotero.getString(clearStrPrefix + 'existingAttachments.singular');
				break;
			
			default:
				msg3 += Zotero.getString(clearStrPrefix + 'existingAttachments.plural', numOldAttachments);
		}
		
		
		var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
			+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL);
		var index = ps.confirmEx(
			null,
			title,
			(msg1 + msg2 + msg3).trim(),
			buttonFlags,
			Zotero.getString(chooseStrPrefix + 'button'),
			null,
			null,
			null,
			{}
		);
		
		if (index == 1) {
			return false;
		}
		
		// Set new data directory
		Zotero.debug("Setting new base directory");
		Zotero.Prefs.set('baseAttachmentPath', basePath);
		Zotero.Prefs.set('saveRelativeAttachmentPath', true);
		// Resave all attachments on base path (so that their paths become relative)
		// and all other relative attachments (so that their paths become absolute)
		yield Zotero.Utilities.Internal.forEachChunkAsync(
			Object.keys(newAttachmentPaths),
			100,
			function (chunk) {
				return Zotero.DB.executeTransaction(function* () {
					for (let id of chunk) {
						let attachment = Zotero.Items.get(id);
						if (newAttachmentPaths[id]) {
							attachment.attachmentPath = newAttachmentPaths[id];
						}
						else {
							attachment.attachmentPath = attachment.getFilePath();
						}
						yield attachment.save({
							skipDateModifiedUpdate: true
						});
					}
				})
			}
		);
		
		return true;
	}),
	
	
	clearPath: Zotero.Promise.coroutine(function* () {
		// Find all current attachments with relative paths
		var sql = "SELECT itemID FROM itemAttachments WHERE linkMode=? AND path LIKE ?";
		var params = [
			Zotero.Attachments.LINK_MODE_LINKED_FILE,
			Zotero.Attachments.BASE_PATH_PLACEHOLDER + "%"
		];
		var relativeAttachmentIDs = yield Zotero.DB.columnQueryAsync(sql, params);
		
		// Prompt for confirmation
		var ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
			.getService(Components.interfaces.nsIPromptService);
		
		var strPrefix = 'attachmentBasePath.clearBasePath.';
		var title = Zotero.getString(strPrefix + 'title');
		var msg = Zotero.getString(strPrefix + 'message');
		switch (relativeAttachmentIDs.length) {
			case 0:
				break;
			
			case 1:
				msg += "\n\n" + Zotero.getString(strPrefix + 'existingAttachments.singular');
				break;
			
			default:
				msg += "\n\n" + Zotero.getString(strPrefix + 'existingAttachments.plural',
					relativeAttachmentIDs.length);
		}
		
		var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
			+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL);
		var index = ps.confirmEx(
			window,
			title,
			msg,
			buttonFlags,
			Zotero.getString(strPrefix + 'button'),
			null,
			null,
			null,
			{}
		);
		
		if (index == 1) {
			return false;
		}
		
		// Disable relative path saving and then resave all relative
		// attachments so that their absolute paths are stored
		Zotero.debug('Clearing base directory');
		Zotero.Prefs.set('saveRelativeAttachmentPath', false);
		
		yield Zotero.Utilities.Internal.forEachChunkAsync(
			relativeAttachmentIDs,
			100,
			function (chunk) {
				return Zotero.DB.executeTransaction(function* () {
					for (let id of chunk) {
						let attachment = yield Zotero.Items.getAsync(id);
						attachment.attachmentPath = attachment.getFilePath();
						yield attachment.save({
							skipDateModifiedUpdate: true
						});
					}
				}.bind(this));
			}.bind(this)
		);
		
		Zotero.Prefs.set('baseAttachmentPath', '');
	}),
	
	
	updateUI: Zotero.Promise.coroutine(function* () {
		var filefield = document.getElementById('baseAttachmentPath');
		var path = Zotero.Prefs.get('baseAttachmentPath');
		Components.utils.import("resource://gre/modules/osfile.jsm");
		if (yield OS.File.exists(path)) {
			filefield.file = Zotero.File.pathToFile(path);
			filefield.label = path;
		}
		else {
			filefield.label = '';
		}
		document.getElementById('resetBasePath').disabled = !path;
	})
};


Zotero_Preferences.Debug_Output = {
	_timer: null,
	
	init: function () {
		var storing = Zotero.Debug.storing;
		this._updateButton();
		this.updateLines();
		if (storing) {
			this._initTimer();
		}
	},
	
	
	toggleStore: function () {
		this.setStore(!Zotero.Debug.storing);
	},
	
	
	setStore: function (set) {
		Zotero.Debug.setStore(set);
		if (set) {
			this._initTimer();
		}
		else {
			if (this._timerID) {
				this._timer.cancel();
				this._timerID = null;
			}
		}
		this._updateButton();
		this.updateLines();
	},
	
	
	view: function () {
		Zotero_Preferences.openInViewer("zotero://debug/");
	},
	
	
	submit: Zotero.Promise.coroutine(function* () {
		document.getElementById('debug-output-submit').disabled = true;
		var pm = document.getElementById('debug-output-submit-progress');
		pm.hidden = false;
		
		Components.utils.import("resource://zotero/config.js");
		
		var url = ZOTERO_CONFIG.REPOSITORY_URL + "report?debug=1";
		var output = yield Zotero.Debug.get(
			Zotero.Prefs.get('debug.store.submitSize'),
			Zotero.Prefs.get('debug.store.submitLineLength')
		);
		Zotero_Preferences.Debug_Output.setStore(false);
		
		var ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
			.getService(Components.interfaces.nsIPromptService);
		try {
			var xmlhttp = yield Zotero.HTTP.request(
				"POST",
				url,
				{
					compressBody: true,
					body: output,
					logBodyLength: 30,
					timeout: 30000,
					requestObserver: function (req) {
						// Don't fail during tests, with fake XHR
						if (!req.channel) {
							return;
						}
						req.channel.notificationCallbacks = {
							onProgress: function (request, context, progress, progressMax) {
								pm.mode = 'determined';
								if (!pm.value || progress > pm.value) {
									pm.value = progress;
								}
								if (!pm.max || progressMax > pm.max) {
									pm.max = progressMax;
								}
							},
							
							// nsIInterfaceRequestor
							getInterface: function (iid) {
								try {
									return this.QueryInterface(iid);
								}
								catch (e) {
									throw Components.results.NS_NOINTERFACE;
								}
							},
							
							QueryInterface: function(iid) {
								if (iid.equals(Components.interfaces.nsISupports) ||
										iid.equals(Components.interfaces.nsIInterfaceRequestor) ||
										iid.equals(Components.interfaces.nsIProgressEventSink)) {
									return this;
								}
								throw Components.results.NS_NOINTERFACE;
							},
			
						}
					}
				}
			);
		}
		catch (e) {
			Zotero.logError(e);
			let title = Zotero.getString('general.error');
			let msg;
			if (e instanceof Zotero.HTTP.UnexpectedStatusException) {
				msg = Zotero.getString('general.invalidResponseServer');
			}
			else if (e instanceof Zotero.HTTP.BrowserOfflineException) {
				msg = Zotero.getString('general.browserIsOffline', Zotero.appName);
			}
			else {
				msg = Zotero.getString('zotero.preferences.advanced.debug.error');
			}
			ps.alert(null, title, msg);
			return false;
		}
		
		document.getElementById('debug-output-submit').disabled = false;
		document.getElementById('debug-output-submit-progress').hidden = true;
		
		Zotero.debug(xmlhttp.responseText);
		
		var reported = xmlhttp.responseXML.getElementsByTagName('reported');
		if (reported.length != 1) {
			ps.alert(
				null,
				Zotero.getString('general.error'),
				Zotero.getString('general.serverError')
			);
			return false;
		}
		
		var reportID = reported[0].getAttribute('reportID');
		ps.alert(
			null,
			Zotero.getString('zotero.preferences.advanced.debug.title'),
			Zotero.getString('zotero.preferences.advanced.debug.sent', reportID)
		);
		
		return true;
	}),
	
	
	clear: function () {
		Zotero.Debug.clear();
		this.updateLines();
	},
	
	
	updateLines: function () {
		var enabled = Zotero.Debug.storing;
		var lines = Zotero.Debug.count();
		document.getElementById('debug-output-lines').value = lines;
		var empty = lines == 0;
		document.getElementById('debug-output-view').disabled = !enabled && empty;
		document.getElementById('debug-output-clear').disabled = empty;
		document.getElementById('debug-output-submit').disabled = empty;
	},
	
	
	_initTimer: function () {
		this._timer = Components.classes["@mozilla.org/timer;1"].
			createInstance(Components.interfaces.nsITimer);
		this._timer.initWithCallback({
			notify: function() {
				Zotero_Preferences.Debug_Output.updateLines();
			}
		}, 10000, Components.interfaces.nsITimer.TYPE_REPEATING_SLACK);
	},
	
	
	_updateButton: function () {
		var storing = Zotero.Debug.storing
		
		var button = document.getElementById('debug-output-enable');
		if (storing) {
			button.label = Zotero.getString('general.disable');
		}
		else {
			button.label = Zotero.getString('general.enable');
		}
	},
	
	
	onUnload: function () {
		if (this._timer) {
			this._timer.cancel();
		}
	}
};


Zotero_Preferences.Keys = {
	init: function () {
		var rows = document.getElementById('zotero-prefpane-advanced-keys-tab').getElementsByTagName('row');
		for (var i=0; i<rows.length; i++) {
			// Display the appropriate modifier keys for the platform
			let label = rows[i].firstChild.nextSibling;
			if (label.className == 'modifier') {
				label.value = Zotero.isMac ? Zotero.getString('general.keys.cmdShift') : Zotero.getString('general.keys.ctrlShift');
			}
		}
		
		var textboxes = document.getElementById('zotero-keys-rows').getElementsByTagName('textbox');
		for (let i=0; i<textboxes.length; i++) {
			let textbox = textboxes[i];
			textbox.value = textbox.value.toUpperCase();
			// .value takes care of the initial value, and this takes care of direct pref changes
			// while the window is open
			textbox.setAttribute('onsyncfrompreference', 'return Zotero_Preferences.Keys.capitalizePref(this.id)');
			textbox.setAttribute('oninput', 'this.value = this.value.toUpperCase()');
		}
	},
	
	
	capitalizePref: function (id) {
		var elem = document.getElementById(id);
		var pref = document.getElementById(elem.getAttribute('preference'));
		if (pref.value) {
			return pref.value.toUpperCase();
		}
	}
};
