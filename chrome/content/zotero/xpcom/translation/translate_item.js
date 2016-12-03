/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2012 Center for History and New Media
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


/**
 * Save translator items
 * @constructor
 * @param {Object} options
 *         <li>libraryID - ID of library in which items should be saved</li>
 *         <li>collections - New collections to create (used during Import translation</li>
 *         <li>attachmentMode - One of Zotero.Translate.ItemSaver.ATTACHMENT_* specifying how attachments should be saved</li>
 *         <li>forceTagType - Force tags to specified tag type</li>
 *         <li>cookieSandbox - Cookie sandbox for attachment requests</li>
 *         <li>baseURI - URI to which attachment paths should be relative</li>
 */
Zotero.Translate.ItemSaver = function(options) {
	// initialize constants
	this._IDMap = {};
	
	// determine library ID
	if(!options.libraryID) {
		this._libraryID = Zotero.Libraries.userLibraryID;
	} else {
		this._libraryID = options.libraryID;
	}
	
	this._collections = options.collections || false;
	
	// If group filesEditable==false, don't save attachments
	this.attachmentMode = Zotero.Libraries.get(this._libraryID).filesEditable ? options.attachmentMode :
	                      Zotero.Translate.ItemSaver.ATTACHMENT_MODE_IGNORE;
	this._forceTagType = options.forceTagType;
	this._cookieSandbox = options.cookieSandbox;
	
	// the URI to which other URIs are assumed to be relative
	if(typeof baseURI === "object" && baseURI instanceof Components.interfaces.nsIURI) {
		this._baseURI = options.baseURI;
	} else {
		// try to convert to a URI
		try {
			this._baseURI = Components.classes["@mozilla.org/network/io-service;1"].
				getService(Components.interfaces.nsIIOService).newURI(options.baseURI, null, null);
		} catch(e) {};
	}
};

Zotero.Translate.ItemSaver.ATTACHMENT_MODE_IGNORE = 0;
Zotero.Translate.ItemSaver.ATTACHMENT_MODE_DOWNLOAD = 1;
Zotero.Translate.ItemSaver.ATTACHMENT_MODE_FILE = 2;

Zotero.Translate.ItemSaver.prototype = {
	/**
	 * Saves items to Standalone or the server
	 * @param items Items in Zotero.Item.toArray() format
	 * @param {Function} callback A callback to be executed when saving is complete. If saving
	 *    succeeded, this callback will be passed true as the first argument and a list of items
	 *    saved as the second. If saving failed, the callback will be passed false as the first
	 *    argument and an error object as the second
	 * @param {Function} [attachmentCallback] A callback that receives information about attachment
	 *     save progress. The callback will be called as attachmentCallback(attachment, false, error)
	 *     on failure or attachmentCallback(attachment, progressPercent) periodically during saving.
	 */
	"saveItems": Zotero.Promise.coroutine(function* (items, callback, attachmentCallback) {
		try {
			let newItems = [], standaloneAttachments = [];
			yield Zotero.DB.executeTransaction(function* () {
				for (let iitem=0; iitem<items.length; iitem++) {
					let item = items[iitem], newItem, myID;
					// Type defaults to "webpage"
					let type = (item.itemType ? item.itemType : "webpage");
					
					if (type == "note") {				// handle notes differently
						newItem = yield this._saveNote(item);
					} else if (type == "attachment") {	// handle attachments differently
						standaloneAttachments.push(iitem);
						continue;
					} else {
						newItem = new Zotero.Item(type);
						newItem.libraryID = this._libraryID;
						if(item.tags) item.tags = this._cleanTags(item.tags);

						// Need to handle these specially. Put them in a separate object to
						// avoid a warning from fromJSON()
						let specialFields = {
							attachments:item.attachments,
							notes:item.notes,
							seeAlso:item.seeAlso,
							id:item.itemID || item.id
						};
						newItem.fromJSON(this._deleteIrrelevantFields(item));
						
						if (this._collections) {
							newItem.setCollections(this._collections);
						}
						
						// save item
						myID = yield newItem.save();

						// handle notes
						if (specialFields.notes) {
							for (let i=0; i<specialFields.notes.length; i++) {
								yield this._saveNote(specialFields.notes[i], myID);
							}
						}

						// handle attachments
						if (specialFields.attachments) {
							for (let i=0; i<specialFields.attachments.length; i++) {
								let attachment = specialFields.attachments[i];
								// Don't wait for the promise to resolve, since we want to
								// signal completion as soon as the items are saved
								this._saveAttachment(attachment, myID, attachmentCallback);
							}
							// Restore the attachments field, since we use it later in
							// translation
							item.attachments = specialFields.attachments;
						}

						// handle see also
						this._handleRelated(specialFields, newItem);
					}

					// add to new item list
					newItems.push(newItem);
				}
			}.bind(this));

			// Handle standalone attachments outside of the transaction
			for (let iitem of standaloneAttachments) {
				let newItem = yield this._saveAttachment(items[iitem], null, attachmentCallback);
				if (newItem) newItems.push(newItem);
			}

			callback(true, newItems);
		} catch(e) {
			callback(false, e);
		}
	}),
	
	"saveCollections": Zotero.Promise.coroutine(function* (collections) {
		var collectionsToProcess = collections.slice();
		var parentIDs = [null];
		var topLevelCollections = [];

		yield Zotero.DB.executeTransaction(function* () {
			while(collectionsToProcess.length) {
				var collection = collectionsToProcess.shift();
				var parentID = parentIDs.shift();

				var newCollection = new Zotero.Collection;
				newCollection.libraryID = this._libraryID;
				newCollection.name = collection.name;
				if (parentID) {
					newCollection.parentID = parentID;
				}
				yield newCollection.save();

				if(parentID === null) topLevelCollections.push(newCollection);

				var toAdd = [];

				for(var i=0; i<collection.children.length; i++) {
					var child = collection.children[i];
					if(child.type === "collection") {
						// do recursive processing of collections
						collectionsToProcess.push(child);
						parentIDs.push(newCollection.id);
					} else {
						// add mapped items to collection
						if(this._IDMap[child.id]) {
							toAdd.push(this._IDMap[child.id]);
						} else {
							Zotero.debug("Translate: Could not map "+child.id+" to an imported item", 2);
						}
					}
				}

				if(toAdd.length) {
					Zotero.debug("Translate: Adding " + toAdd, 5);
					yield newCollection.addItems(toAdd);
				}
			}
		}.bind(this));

		return topLevelCollections;
	}),

	/**
	 * Deletes irrelevant fields from an item object to avoid warnings in Item#fromJSON
	 * Also delete some things like dateAdded, dateModified, and path that translators
	 * should not be able to set directly.
	 */
	"_deleteIrrelevantFields": function(item) {
		const DELETE_FIELDS = ["attachments", "notes", "dateAdded", "dateModified", "seeAlso", "version", "id", "itemID", "path"];
		for (let i=0; i<DELETE_FIELDS.length; i++) delete item[DELETE_FIELDS[i]];
		return item;
	},
	
	/**
	 * Saves a translator attachment to the database
	 *
	 * @param {Translator Attachment} attachment
	 * @param {Integer} parentID Item to attach to
	 * @param {Function} attachmentCallback Callback function that takes three
	 *   parameters: translator attachment object, percent completion (integer),
	 *   and an optional error object
	 *
	 * @return {Zotero.Primise<Zotero.Item|False} Flase is returned if attachment
	 *   was not saved due to error or user settings.
	 */
	"_saveAttachment": Zotero.Promise.coroutine(function* (attachment, parentID, attachmentCallback) {
		try {
			let newAttachment;

			// determine whether to save files and attachments
			if (this.attachmentMode == Zotero.Translate.ItemSaver.ATTACHMENT_MODE_DOWNLOAD) {
				newAttachment = yield this._saveAttachmentDownload.apply(this, arguments);
			} else if (this.attachmentMode == Zotero.Translate.ItemSaver.ATTACHMENT_MODE_FILE) {
				newAttachment = yield this._saveAttachmentFile.apply(this, arguments);
			} else {
				Zotero.debug('Translate: Ignoring attachment due to ATTACHMENT_MODE_IGNORE');
				return false;
			}
			
			if (!newAttachment) return false; // attachmentCallback should not have been called in this case

			// save fields
			if (attachment.accessDate) newAttachment.setField("accessDate", attachment.accessDate);
			if (attachment.tags) newAttachment.setTags(this._cleanTags(attachment.tags));
			if (attachment.note) newAttachment.setNote(attachment.note);
			this._handleRelated(attachment, newAttachment);
			yield newAttachment.saveTx();

			Zotero.debug("Translate: Created attachment; id is " + newAttachment.id, 4);
			attachmentCallback(attachment, 100);
			return newAttachment;
		} catch(e) {
			Zotero.debug(e, 2);
			attachmentCallback(attachment, false, e);
			return false;
		}
	}),
	
	"_saveAttachmentFile": Zotero.Promise.coroutine(function* (attachment, parentID, attachmentCallback) {
		Zotero.debug("Translate: Adding attachment", 4);
		attachmentCallback(attachment, 0);
		
		if(!attachment.url && !attachment.path) {
			throw new Error("Translate: Ignoring attachment: no path or URL specified");
		}
		
		if (attachment.path) {
			var url = Zotero.Attachments.cleanAttachmentURI(attachment.path, false);
			if (url && /^(?:https?|ftp):/.test(url)) {
				// A web URL. Don't bother parsing it as path below
				// Some paths may look like URIs though, so don't just test for 'file'
				// E.g. C:\something
				if (!attachment.url) attachment.url = attachment.path;
				delete attachment.path;
			}
		}
		
		let newItem;
		var file = attachment.path && this._parsePath(attachment.path);
		if (!file) {
			if (attachment.path) {
				let asUrl = Zotero.Attachments.cleanAttachmentURI(attachment.path);
				if (!attachment.url && !asUrl) {
					throw new Error("Translate: Could not parse attachment path <" + attachment.path + ">");
				}

				if (!attachment.url && asUrl) {
					Zotero.debug("Translate: attachment path looks like a URI: " + attachment.path);
					attachment.url = asUrl;
					delete attachment.path;
				}
			}

			let url = Zotero.Attachments.cleanAttachmentURI(attachment.url);
			if (!url) {
				throw new Error("Translate: Invalid attachment.url specified <" + attachment.url + ">");
			}

			attachment.url = url;
			url = Components.classes["@mozilla.org/network/io-service;1"]
				.getService(Components.interfaces.nsIIOService)
				.newURI(url, null, null); // This cannot fail, since we check above

			// see if this is actually a file URL
			if(url.scheme == "file") {
				throw new Error("Translate: Local file attachments cannot be specified in attachment.url");
			} else if(url.scheme != "http" && url.scheme != "https") {
				throw new Error("Translate: " + url.scheme + " protocol is not allowed for attachments from translators.");
			}

			// At this point, must be a valid HTTP/HTTPS url
			attachment.linkMode = "linked_file";
			newItem = yield Zotero.Attachments.linkFromURL({
				url: attachment.url,
				parentItemID: parentID,
				contentType: attachment.mimeType || undefined,
				title: attachment.title || undefined
			});
		} else {
			if (attachment.url) {
				attachment.linkMode = "imported_url";
				newItem = yield Zotero.Attachments.importSnapshotFromFile({
					file: file,
					url: attachment.url,
					title: attachment.title,
					contentType: attachment.mimeType,
					charset: attachment.charset,
					parentItemID: parentID
				});
			}
			else {
				attachment.linkMode = "imported_file";
				newItem = yield Zotero.Attachments.importFromFile({
					file: file,
					parentItemID: parentID
				});
				if (attachment.title) newItem.setField("title", attachment.title);
			}
		}
		
		return newItem;
	}),

	"_parsePathURI":function(path) {
		try {
			var uri = Services.io.newURI(path, "", this._baseURI);
		} catch(e) {
			Zotero.debug("Translate: " + path + " is not a valid URI");
			return false;
		}
		
		try {
			var file = uri.QueryInterface(Components.interfaces.nsIFileURL).file;
		}
		catch (e) {
			Zotero.debug("Translate: " + uri.spec + " is not a file URI");
			return false;
		}
		
		if(file.path == '/') {
			Zotero.debug("Translate: " + path + " points to root directory");
			return false;
		}
		
		if(!file.exists()) {
			Zotero.debug("Translate: File at " + file.path + " does not exist");
			return false;
		}
		
		return file;
	},

	"_parseAbsolutePath":function(path) {
		var file = Components.classes["@mozilla.org/file/local;1"].
			createInstance(Components.interfaces.nsILocalFile);
		try {
			file.initWithPath(path);
		} catch(e) {
			Zotero.debug("Translate: Invalid absolute path: " + path);
			return false;
		}
		
		if(!file.exists()) {
			Zotero.debug("Translate: File at absolute path " + file.path + " does not exist");
			return false;
		}
		
		return file;
	},

	"_parseRelativePath":function(path) {
		if (!this._baseURI) {
			Zotero.debug("Translate: Cannot parse as relative path. No base URI available.");
			return false;
		}
		
		var file = this._baseURI.QueryInterface(Components.interfaces.nsIFileURL).file.parent;
		var splitPath = path.split(/\//g);
		for(var i=0; i<splitPath.length; i++) {
			if(splitPath[i] !== "") file.append(splitPath[i]);
		}
		
		if(!file.exists()) {
			Zotero.debug("Translate: File at " + file.path + " does not exist");
			return false;
		}
		
		return file;
	},

	"_parsePath":function(path) {
		Zotero.debug("Translate: Attempting to parse path " + path);
		
		var file;

		// First, try to parse as absolute path
		if((/^[a-zA-Z]:[\\\/]|^\\\\/.test(path) && Zotero.isWin) // Paths starting with drive letter or network shares starting with \\
			|| (path[0] === "/" && !Zotero.isWin)) {
			// Forward slashes on Windows are not allowed in filenames, so we can
			// assume they're meant to be backslashes. Backslashes are technically
			// allowed on Linux, so the reverse cannot be done reliably.
			var nativePath = Zotero.isWin ? path.replace('/', '\\', 'g') : path;
			if (file = this._parseAbsolutePath(nativePath)) {
				Zotero.debug("Translate: Got file "+nativePath+" as absolute path");
				return file;
			}
		}

		// Next, try to parse as URI
		if((file = this._parsePathURI(path))) {
			Zotero.debug("Translate: Got "+path+" as URI")
			return file;
		} else if(path.substr(0, 7) !== "file://") {
			// If it was a fully qualified file URI, we can give up now

			// Next, try to parse as relative path, replacing backslashes with slashes
			if((file = this._parseRelativePath(path.replace(/\\/g, "/")))) {
				Zotero.debug("Translate: Got file "+path+" as relative path");
				return file;
			}

			// Next, try to parse as relative path, without replacing backslashes with slashes
			if((file = this._parseRelativePath(path))) {
				Zotero.debug("Translate: Got file "+path+" as relative path");
				return file;
			}

			if(path[0] !== "/") {
				// Next, try to parse a path with no / as an absolute URI or path
				if((file = this._parsePathURI("/"+path))) {
					Zotero.debug("Translate: Got file "+path+" as broken URI");
					return file;
				}

				if((file = this._parseAbsolutePath("/"+path))) {
					Zotero.debug("Translate: Got file "+path+" as broken absolute path");
					return file;
				}

			}
		}

		// Give up
		Zotero.debug("Translate: Could not find file "+path)

		return false;
	},
	
	"_saveAttachmentDownload": Zotero.Promise.coroutine(function* (attachment, parentID, attachmentCallback) {
		Zotero.debug("Translate: Adding attachment", 4);
		
		if(!attachment.url && !attachment.document) {
			Zotero.debug("Translate: Not adding attachment: no URL specified");
			return false;
		}
		
		// Determine whether to save an attachment
		if(attachment.snapshot !== false) {
			if(attachment.document || Zotero.MIME.isWebPageType(attachment.mimeType)) {
				if(!Zotero.Prefs.get("automaticSnapshots")) {
					Zotero.debug("Translate: Not adding attachment: automatic snapshots are disabled");
					return false;
				}
			} else {
				if(!Zotero.Prefs.get("downloadAssociatedFiles")) {
					Zotero.debug("Translate: Not adding attachment: automatic file attachments are disabled");
					return false;
				}
			}
		}
		
		let doc = undefined;
		if(attachment.document) {
			doc = new XPCNativeWrapper(Zotero.Translate.DOMWrapper.unwrap(attachment.document));
			if(!attachment.title) attachment.title = doc.title;
		}
		
		// If no title provided, use "Attachment" as title for progress UI (but not for item)
		let title = attachment.title || null;
		if(!attachment.title) {
			attachment.title = Zotero.getString("itemTypes.attachment");
		}
		
		// Commit to saving
		attachmentCallback(attachment, 0);
		
		if(attachment.snapshot === false || this.attachmentMode === Zotero.Translate.ItemSaver.ATTACHMENT_MODE_IGNORE) {
			// if snapshot is explicitly set to false, attach as link
			attachment.linkMode = "linked_url";
			let url, mimeType;
			if(attachment.document) {
				url = attachment.document.location.href;
				mimeType = attachment.mimeType || attachment.document.contentType;
			} else {
				url = attachment.url
				mimeType = attachment.mimeType || undefined;
			}
			
			if(!mimeType || !title) {
				Zotero.debug("Translate: mimeType or title is missing; attaching link to URL will be slower");
			}
			
			let cleanURI = Zotero.Attachments.cleanAttachmentURI(url);
			if (!cleanURI) {
				throw new Error("Translate: Invalid attachment URL specified <" + url + ">");
			}
			url = Components.classes["@mozilla.org/network/io-service;1"]
				.getService(Components.interfaces.nsIIOService)
				.newURI(cleanURI, null, null); // This cannot fail, since we check above
			
			// Only HTTP/HTTPS links are allowed
			if(url.scheme != "http" && url.scheme != "https") {
				throw new Error("Translate: " + url.scheme + " protocol is not allowed for attachments from translators.");
			}
			
			return Zotero.Attachments.linkFromURL({
				url: cleanURI,
				parentItemID: parentID,
				contentType: mimeType,
				title: title
			});
		}
		
		// Snapshot is not explicitly set to false, import as file attachment
		
		// Import from document
		if(attachment.document) {
			Zotero.debug('Importing attachment from document');
			attachment.linkMode = "imported_url";
			
			return Zotero.Attachments.importFromDocument({
				libraryID: this._libraryID,
				document: attachment.document,
				parentItemID: parentID,
				title: title
			});
		}
		
		// Import from URL
		let mimeType = attachment.mimeType ? attachment.mimeType : null;
		let fileBaseName;
		if (parentID) {
			let parentItem = yield Zotero.Items.getAsync(parentID);
			fileBaseName = Zotero.Attachments.getFileBaseNameFromItem(parentItem);
		}
		
		Zotero.debug('Importing attachment from URL');
		attachment.linkMode = "imported_url";
		
		attachmentCallback(attachment, 0);
		
		return Zotero.Attachments.importFromURL({
			libraryID: this._libraryID,
			url: attachment.url,
			parentItemID: parentID,
			title: title,
			fileBaseName: fileBaseName,
			contentType: mimeType,
			cookieSandbox: this._cookieSandbox
		});
	}),
	
	"_saveNote":Zotero.Promise.coroutine(function* (note, parentID) {
		var myNote = new Zotero.Item('note');
		myNote.libraryID = this._libraryID;
		if(parentID) {
			myNote.parentID = parentID;
		}

		if(typeof note == "object") {
			myNote.setNote(note.note);
			if(note.tags) myNote.setTags(this._cleanTags(note.tags));
			this._handleRelated(note, myNote);
		} else {
			myNote.setNote(note);
		}
		if (!parentID && this._collections) {
			myNote.setCollections(this._collections);
		}
		yield myNote.save();
		return myNote;
	}),

	/**
	 * Remove automatic tags if automatic tags pref is on, and set type
	 * to automatic if forced
	 */
	"_cleanTags":function(tags) {
		// If all tags are automatic and automatic tags pref is on, return immediately
		let tagPref = Zotero.Prefs.get("automaticTags");
		if(this._forceTagType == 1 && !tagPref) return [];

		let newTags = [];
		for(let i=0; i<tags.length; i++) {
			let tag = tags[i];
			// Convert raw string to object with 'tag' property
			if (typeof tag == 'string') {
				tag = { tag };
			}
			tag.type = this._forceTagType || tag.type || 0;
			newTags.push(tag);
		}
		return newTags;
	},
	
	"_handleRelated":function(item, newItem) {
		// add to ID map
		if(item.itemID || item.id) {
			this._IDMap[item.itemID || item.id] = newItem.id;
		}

		// // add see alsos
		// if(item.seeAlso) {
		// 	for(var i=0; i<item.seeAlso.length; i++) {
		// 		var seeAlso = item.seeAlso[i];
		// 		if(this._IDMap[seeAlso]) {
		// 			newItem.addRelatedItem(this._IDMap[seeAlso]);
		// 		}
		// 	}
		// 	newItem.save();
		// }
	}
}

Zotero.Translate.ItemGetter = function() {
	this._itemsLeft = [];
	this._collectionsLeft = null;
	this._exportFileDirectory = null;
	this.legacy = false;
};

Zotero.Translate.ItemGetter.prototype = {
	"setItems":function(items) {
		this._itemsLeft = items;
		this._itemsLeft.sort(function(a, b) { return a.id - b.id; });
		this.numItems = this._itemsLeft.length;
	},
	
	"setCollection": function (collection, getChildCollections) {
		// get items in this collection
		var items = new Set(collection.getChildItems());
		
		if(getChildCollections) {
			// get child collections
			this._collectionsLeft = Zotero.Collections.getByParent(collection.id, true);
			
			// get items in child collections
			for (let collection of this._collectionsLeft) {
				var childItems = collection.getChildItems();
				childItems.forEach(item => items.add(item));
			}
		}
		
		this._itemsLeft = Array.from(items.values());
		this._itemsLeft.sort(function(a, b) { return a.id - b.id; });
		this.numItems = this._itemsLeft.length;
	},
	
	"setAll": Zotero.Promise.coroutine(function* (libraryID, getChildCollections) {
		this._itemsLeft = yield Zotero.Items.getAll(libraryID, true);
		
		if(getChildCollections) {
			this._collectionsLeft = Zotero.Collections.getByLibrary(libraryID, true);
		}
		
		this._itemsLeft.sort(function(a, b) { return a.id - b.id; });
		this.numItems = this._itemsLeft.length;
	}),
	
	"exportFiles":function(dir, extension) {
		// generate directory
		this._exportFileDirectory = Components.classes["@mozilla.org/file/local;1"].
		                createInstance(Components.interfaces.nsILocalFile);
		this._exportFileDirectory.initWithFile(dir.parent);
		
		// delete this file if it exists
		if(dir.exists()) {
			dir.remove(true);
		}
		
		// get name
		var name = dir.leafName;
		this._exportFileDirectory.append(name);
		
		// create directory
		this._exportFileDirectory.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0700);
		
		// generate a new location for the exported file, with the appropriate
		// extension
		var location = Components.classes["@mozilla.org/file/local;1"].
		                createInstance(Components.interfaces.nsILocalFile);
		location.initWithFile(this._exportFileDirectory);
		location.append(name+"."+extension);

		return location;
	},
	
	/**
	 * Converts an attachment to array format and copies it to the export folder if desired
	 */
	"_attachmentToArray": function (attachment) {
		var attachmentArray = Zotero.Utilities.Internal.itemToExportFormat(attachment, this.legacy);
		var linkMode = attachment.attachmentLinkMode;
		if(linkMode != Zotero.Attachments.LINK_MODE_LINKED_URL) {
			attachmentArray.localPath = attachment.getFilePath();
			
			if(this._exportFileDirectory) {
				var exportDir = this._exportFileDirectory;
				
				// Add path and filename if not an internet link
				var attachFile = Zotero.File.pathToFile(attachmentArray.localPath);
				// TODO: Make async, but that will require translator changes
				if (attachFile.exists()) {
					attachmentArray.defaultPath = "files/" + attachment.id + "/" + attachFile.leafName;
					attachmentArray.filename = attachFile.leafName;
					
					/**
					 * Copies the attachment file to the specified relative path from the
					 * export directory.
					 * @param {String} attachPath The path to which the file should be exported 
					 *    including the filename. If supporting files are included, they will be
					 *    copied as well without any renaming. 
					 * @param {Boolean} overwriteExisting Optional - If this is set to false, the
					 *    function will throw an error when exporting a file would require an existing
					 *    file to be overwritten. If true, the file will be silently overwritten.
					 *    defaults to false if not provided. 
					 */
					attachmentArray.saveFile = function(attachPath, overwriteExisting) {
						// Ensure a valid path is specified
						if(attachPath === undefined || attachPath == "") {
							throw new Error("ERROR_EMPTY_PATH");
						}
						
						// Set the default value of overwriteExisting if it was not provided
						if (overwriteExisting === undefined) {
							overwriteExisting = false;
						}
						
						// Separate the path into a list of subdirectories and the attachment filename,
						// and initialize the required file objects
						var targetFile = Components.classes["@mozilla.org/file/local;1"].
								createInstance(Components.interfaces.nsILocalFile);
						targetFile.initWithFile(exportDir);
						for (let dir of attachPath.split("/")) targetFile.append(dir);
						
						// First, check that we have not gone lower than exportDir in the hierarchy
						var parent = targetFile, inExportFileDirectory;
						while((parent = parent.parent)) {
							if(exportDir.equals(parent)) {
								inExportFileDirectory = true;
								break;
							}
						}
						
						if(!inExportFileDirectory) {
							throw new Error("Invalid path; attachment cannot be placed above export "+
								"directory in the file hirarchy");
						}
						
						// Create intermediate directories if they don't exist
						parent = targetFile;
						while((parent = parent.parent) && !parent.exists()) {
							parent.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0700);
						}
						
						// Delete any existing file if overwriteExisting is set, or throw an exception
						// if it is not
						if(targetFile.exists()) {
							if(overwriteExisting) {
								targetFile.remove(false);
							} else {
								throw new Error("ERROR_FILE_EXISTS " + targetFile.leafName);
							}
						}
						
						var directory = targetFile.parent;
						
						// The only attachments that can have multiple supporting files are imported
						// attachments of mime type text/html
						//
						// TEMP: This used to check getNumFiles() here, but that's now async.
						// It could be restored (using hasMultipleFiles()) when this is made
						// async, but it's probably not necessary. (The below can also be changed
						// to use OS.File.DirectoryIterator.)
						if(attachment.attachmentContentType == "text/html"
								&& linkMode != Zotero.Attachments.LINK_MODE_LINKED_FILE) {
							// Attachment is a snapshot with supporting files. Check if any of the
							// supporting files would cause a name conflict, and build a list of transfers
							// that should be performed
							var copySrcs = [];
							var files = attachment.getFile().parent.directoryEntries;
							while (files.hasMoreElements()) {
								file = files.getNext();
								file.QueryInterface(Components.interfaces.nsIFile);
								
								// Ignore the main attachment file (has already been checked for name conflict)
								if(attachFile.equals(file)) {
									continue;
								}
								
								// Remove any existing files in the target destination if overwriteExisting 
								// is set, or throw an exception if it is not
								var targetSupportFile = targetFile.parent.clone();
								targetSupportFile.append(file.leafName);
								if(targetSupportFile.exists()) {
									if(overwriteExisting) {
										targetSupportFile.remove(false);
									} else {
										throw new Error("ERROR_FILE_EXISTS " + targetSupportFile.leafName);
									}
								}
								copySrcs.push(file.clone());
							}
							
							// No conflicts were detected or all conflicts were resolved, perform the copying
							attachFile.copyTo(directory, targetFile.leafName);
							for(var i = 0; i < copySrcs.length; i++) {
								copySrcs[i].copyTo(directory, copySrcs[i].leafName);
							}
						} else {
							// Attachment is a single file
							// Copy the file to the specified location
							attachFile.copyTo(directory, targetFile.leafName);
						}
						
						attachmentArray.path = targetFile.path;
					};
				}
			}
		}
		
		return attachmentArray;
	},
	
	/**
	 * Retrieves the next available item
	 */
	"nextItem": function () {
		while(this._itemsLeft.length != 0) {
			var returnItem = this._itemsLeft.shift();
			// export file data for single files
			if(returnItem.isAttachment()) {		// an independent attachment
				var returnItemArray = this._attachmentToArray(returnItem);
				if(returnItemArray) return returnItemArray;
			} else {
				var returnItemArray = Zotero.Utilities.Internal.itemToExportFormat(returnItem, this.legacy);
				
				// get attachments, although only urls will be passed if exportFileData is off
				returnItemArray.attachments = [];
				var attachments = returnItem.getAttachments();
				for (let attachmentID of attachments) {
					var attachment = Zotero.Items.get(attachmentID);
					var attachmentInfo = this._attachmentToArray(attachment);
					
					if(attachmentInfo) {
						returnItemArray.attachments.push(attachmentInfo);
					}
				}
				
				return returnItemArray;
			}
		}
		return false;
	},
	
	"nextCollection":function() {
		if(!this._collectionsLeft || this._collectionsLeft.length == 0) return false;
	
		var returnItem = this._collectionsLeft.shift();
		var obj = returnItem.serialize(true);
		obj.id = obj.primary.collectionID;
		obj.name = obj.fields.name;
		return obj;
	}
}
Zotero.Translate.ItemGetter.prototype.__defineGetter__("numItemsRemaining", function() { return this._itemsLeft.length });
