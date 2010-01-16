/*
  KeeFox - Allows Firefox to communicate with KeePass (via the KeeICE KeePass-plugin)
  Copyright 2008-2009 Chris Tomlinson <keefox@christomlinson.name>
  
  This is the KeeFox Improved Login Manager javascript file. The KFILM object
  is mainly concerned with user-visible behaviour and actual use of the data
  in the active KeePass database. Eventually this should have enough options
  and features to allow the user fine control over their password management
  experience.
  
  Some of the code is based on Mozilla's nsLoginManager.js, used under
  GPL 2.0 terms. Lots of the functions are currently unused and really just
  there in case they prove useful in the future.

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program; if not, write to the Free Software
  Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
*/

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

var Application = Components.classes["@mozilla.org/fuel/application;1"].getService(Components.interfaces.fuelIApplication);

function KFILM(kf,keeFoxToolbar,currentWindow) {

    this._kf = kf;
    this._toolbar = keeFoxToolbar;
    this._currentWindow = currentWindow;
    this._refillTimer = Components.classes["@mozilla.org/timer;1"].createInstance(Components.interfaces.nsITimer);

    this.init();
    KFLog.debug("currentWindowName:" + currentWindow.name);
    KFLog.debug ("KFILM constructor finished");
}

KFILM.prototype = {
    _test : null,
    _currentWindow : null,
    _remember : true,  // (eventually) mirrors extension.keeFox.rememberSignons preference
    _kf : null, // KeeFox object (e.g. for xpcom service access)
    _toolbar : null, // the keefox toolbar in this scope
    _kfLoginInfo : null, // Constructor for kfILoginInfo implementation
    _refillTimer : null,
    
    __ioService: null, // IO service for string -> nsIURI conversion
    get _ioService() {
        if (!this.__ioService)
            this.__ioService = Cc["@mozilla.org/network/io-service;1"].
                               getService(Ci.nsIIOService);
        return this.__ioService;
    },


    __formFillService : null, // FormFillController, for username autocompleting
    get _formFillService() {
        if (!this.__formFillService)
            this.__formFillService =
                            Cc["@mozilla.org/satchel/form-fill-controller;1"].
                            getService(Ci.nsIFormFillController);
        return this.__formFillService;
    },
    
    //TODO: improve weighting of matches to reflect real world tests
    _calculateRelevanceScore : function (login, form, usernameIndex, passwordFields, currentTabPage) {
    
        // entry priorities override any relevance based on URL, etc. (remember that we are already dealing only with those entries that KeeICE says are relevant for this domain).
        if (login.priority > 0)
            return (1000000 - login.priority);

        var score = 0;
        var actionURL = this._getActionOrigin(form);
        var URL = form.baseURI;
        
        // NB: action url on 2nd page will not match. This is probably OK but will review if required.
        if (actionURL == login.formActionURL)
            score += 20;
            
        if (this._getURIExcludingQS(actionURL) == this._getURIExcludingQS(login.formActionURL))
            score += 15;
            
        if (this._getURISchemeHostAndPort(actionURL) == this._getURISchemeHostAndPort(login.formActionURL))
            score += 10;
            
        if (this._getURIHostAndPort(actionURL) == this._getURIHostAndPort(login.formActionURL))
            score += 8;
            
        var maxURLscore = 0;
        
        for (i = 0; i < login.URLs.length; i++)
        {
            var URLscore=0;
            // Unfortunately the container is declared to have elements
            // that are generic nsIMutableArray. So, we must QI...
            var loginURL = login.URLs.queryElementAt(i,Components.interfaces.kfIURL);
            
            if (KFLog.logSensitiveData) KFLog.debug(loginURL.URL);

            if (URL == loginURL.URL)
                URLscore = 22;
            else if (this._getURIExcludingQS(URL) == this._getURIExcludingQS(loginURL.URL))
                URLscore = 15;
            else if (this._getURISchemeHostAndPort(URL) == this._getURISchemeHostAndPort(loginURL.URL))
                URLscore = 9;
            else if (this._getURIHostAndPort(URL) == this._getURIHostAndPort(loginURL.URL))
                URLscore = 4;
            
            if (URLscore > maxURLscore)
                maxURLscore = URLscore;
        }
        
        score += maxURLscore;

        // TODO: username and password field test unlikely to help much but shouldn't harm either so will leave it in for testing for a bit
        //TODO: disabled until see need to modify for new index based username data
        //if (login.username != null && usernameField.name == login.username.name)
        //    score += 3;
        
        // TODO: password test currently disabled - re-enable by making it work with multi-passwords.    
        //if (passwordField == login.passwordField)
        //    score += 2;
        
        KFLog.info("Relevance for " + login.uniqueID + " is: "+score);
        return score;
    },
    

    init : function () {
        KFLog.debug("ILM init start");
        
        // Cache references to current |this| in utility objects
        this._webProgressListener._domEventListener = this._domEventListener;
        this._webProgressListener._pwmgr = this;
        
        this._domEventListener._pwmgr    = this;
        this._observer._pwmgr            = this;

        // Get constructor for kfILoginInfo
        this._kfLoginInfo = new Components.Constructor(
            "@christomlinson.name/kfLoginInfo;1", Ci.kfILoginInfo);

        // Form submit observer checks forms for new logins and pw changes.
        var observerService = Cc["@mozilla.org/observer-service;1"].
                              getService(Ci.nsIObserverService);
        observerService.addObserver(this._observer, "earlyformsubmit", false);
        observerService.addObserver(this._observer, "xpcom-shutdown", false);

        // WebProgressListener for getting notification of new doc loads.
        var progress = Cc["@mozilla.org/docloaderservice;1"].
                       getService(Ci.nsIWebProgress);

        try {
            progress.addProgressListener(this._webProgressListener,
              Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT 
              | Ci.nsIWebProgress.NOTIFY_LOCATION);        
        } catch (e) {
            KFLog.error("couldn't add nsIWebProgress listener: " + e);
        }
        
        KFLog.debug("ILM init complete");
    },
    
    _countAllDocuments : function (window)
    {
        var localDocCount = 1;
        
        if (window.frames.length > 0)
        {
            //KFLog.debug("Filling " + window.frames.length + " sub frames");
            var frames = window.frames;
            for (var i = 0; i < frames.length; i++) { 
              localDocCount += this._countAllDocuments (frames[i]);
            }
        }
        return localDocCount;
        
    },
    
    /*
     * _observer object
     *
     * Internal utility object, implements the nsIObserver interface.
     * Used to receive notification for: form submission, preference changes.
     */
    _observer : {
        _pwmgr : null,

        QueryInterface : XPCOMUtils.generateQI([Ci.nsIObserver, 
                                                Ci.nsIFormSubmitObserver,
                                                Ci.nsISupportsWeakReference]),

        // nsFormSubmitObserver
        notify : function (formElement, aWindow, actionURI) {
        
            //TODO: HACK ALERT: Obviously i should remove the form observer from closed windows but this should get us up and running quickly and i'll work out how to do that later.
            if (typeof Components == "undefined")
                return true;
        
            KFLog.debug("observer notified for form submission.");

            try {
                if (keeFoxInst._keeFoxStorage.get("KeeICEActive", false))
                {
                    // We don't do this unless we have a KeeICE connection
                    //TODO: improve so it prompts user to load KeePass
                    this._pwmgr._onFormSubmit(formElement);
                }
            } catch (e) {
                KFLog.error("Caught error in onFormSubmit: " + e);
            }

            return true; // Always return true, or form submit will be canceled.
        },

        // nsObserver
        observe : function (subject, topic, data) {

            /*if (topic == "nsPref:changed") {
                var prefName = data;
                this._pwmgr.log("got change to " + prefName + " preference");

                if (prefName == "debug") {
                    this._pwmgr._debug = 
                        this._pwmgr._prefBranch.getBoolPref("debug");
                } else if (prefName == "rememberSignons") {
                    this._pwmgr._remember =
                        this._pwmgr._prefBranch.getBoolPref("rememberSignons");
                } else {
                    this._pwmgr.log("Oops! Pref not handled, change ignored.");
                }
            } else */if (topic == "xpcom-shutdown") {
                for (let i in this._pwmgr) {
                  try {
                    this._pwmgr[i] = null;
                  } catch(ex) {}
                }
                this._pwmgr = null;
            } else {
                KFLog.warn("Unexpected notification: " + topic);
            }
        }
    },


    /*
     * _webProgressListener object
     *
     * Internal utility object, implements nsIWebProgressListener interface.
     * This is attached to the document loader service, so we get
     * notifications about all page loads.
     */
    _webProgressListener : {
        _pwmgr : null,
        _domEventListener : null,

        QueryInterface : XPCOMUtils.generateQI([Ci.nsIWebProgressListener,
                                                Ci.nsISupportsWeakReference]),


        onStateChange : function (aWebProgress, aRequest,
                                  aStateFlags,  aStatus) {

            // STATE_START is too early, doc is still the old page.
            if (!(aStateFlags & Ci.nsIWebProgressListener.STATE_TRANSFERRING))
                return;

            //if (!this._pwmgr._remember)
            //    return;

            var domWin = aWebProgress.DOMWindow;
            var domDoc = domWin.document;
            //this._pwmgr.log("winName:" + this._pwmgr._currentWindow.name);
            //this._pwmgr.log(this._pwmgr._test);
            //aWebProgress.DOMWindow.top.alert("test");
            //aWebProgress.alert("test");
            
            var mainWindow = domWin.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                   .getInterface(Components.interfaces.nsIWebNavigation)
                   .QueryInterface(Components.interfaces.nsIDocShellTreeItem)
                   .rootTreeItem
                   .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                   .getInterface(Components.interfaces.nsIDOMWindow); 

            if (mainWindow != this._pwmgr._currentWindow)
                return;
                
            // Only process things which might have HTML forms.
            if (!(domDoc instanceof Ci.nsIDOMHTMLDocument))
                return;

            if (KFLog.logSensitiveData) KFLog.debug("onStateChange accepted: req = " +
                            (aRequest ?  aRequest.name : "(null)") +
                            ", flags = 0x" + aStateFlags.toString(16));

            var b = getBrowser();
            var currentTab = b.selectedTab; //TODO: are we sure this always the tab that this event refers to?

            var ss = Components.classes["@mozilla.org/browser/sessionstore;1"]
                    .getService(Components.interfaces.nsISessionStore);

            // see if this tab has our special attributes and promote them to session data
            if (currentTab.hasAttribute("KF_uniqueID")) {

                KFLog.debug("has uid");
                
                ss.setTabValue(currentTab, "KF_uniqueID", currentTab.getAttribute("KF_uniqueID"));
                ss.setTabValue(currentTab, "KF_autoSubmit", "yes");
                currentTab.removeAttribute("KF_uniqueID")
            } else
            {
                KFLog.debug("nouid");
            }
            
            // If this tab location has changed domain then we assume user
            // wants to cancel any outstanding form filling or saving
            // procedures. Same applies if this is a refresh of the existing
            // page. Also, if we are not at the top of the history stack, we
            // can safely assume that we do not need to keep any information
            // about preferred login uniqueIDs (although maybe one day this
            // could complicate options with respect to one-click logins?
            // probably will be fine but look here if problems occur)
            
            removeTabSessionStoreData = false;
            
            //TODO: How do we reliably detect a page refresh?
            
            try {
                if (!(this._pwmgr._getURIScheme(domWin.history.current) == "file"
                     && this._pwmgr._getURIScheme(domWin.history.previous) == "file")
                     && (
                        this._pwmgr._getURIScheme(domWin.history.current) == "file"
                        || this._pwmgr._getURIScheme(domWin.history.previous) == "file"
                        ||
                        (domWin.history.current != domWin.history.previous                         
                            && this._pwmgr._getURISchemeHostAndPort(domWin.history.current)
                            != this._pwmgr._getURISchemeHostAndPort(domWin.history.previous) 
                        )
                        )
                   )
                {
                    removeTabSessionStoreData = true;
                }
            } catch (ex) {
                
            }
            
            try {
                if (domWin.history.next != undefined 
                    && domWin.history.next != null 
                    && domWin.history.next != "")
                {
                    removeTabSessionStoreData = true;
                }
            } catch (ex) {
               
            }
            
            
            // When pages are being navigated without form
            // submissions we want to cancel multi-page login forms 
            var formSubmitTrackerCount = ss.getTabValue(currentTab, "KF_formSubmitTrackerCount");
            var pageLoadSinceSubmitTrackerCount = ss.getTabValue(currentTab, "KF_pageLoadSinceSubmitTrackerCount");

//if (numberOfTabFillsTarget != undefined && numberOfTabFillsTarget != null && numberOfTabFillsTarget != "")
//        {
        
            if (formSubmitTrackerCount > 0)
            {
                KFLog.debug("formSubmitTrackerCount > 0");
                pageLoadSinceSubmitTrackerCount++;
                
                if (pageLoadSinceSubmitTrackerCount > this._pwmgr._countAllDocuments(domWin))
                {
                    KFLog.debug("pageLoadSinceSubmitTrackerCount > this._pwmgr._countAllDocuments(domWin)");
                    formSubmitTrackerCount = 0;
                    pageLoadSinceSubmitTrackerCount = 0;
                    removeTabSessionStoreData = true;
                    ss.setTabValue(currentTab, "KF_formSubmitTrackerCount", formSubmitTrackerCount);
                }
            
                ss.setTabValue(currentTab, "KF_pageLoadSinceSubmitTrackerCount", pageLoadSinceSubmitTrackerCount);
            }        
        
            if (removeTabSessionStoreData)
            {
                // remove the data that helps us track multi-page logins, etc.
                KFLog.debug("Removing the data that helps us track multi-page logins, etc.");
                keeFoxToolbar.clearTabFormRecordingData();
                keeFoxToolbar.clearTabFormFillData();                
            }
                
            // Fastback doesn't fire DOMContentLoaded, so process forms now.
            if (aStateFlags & Ci.nsIWebProgressListener.STATE_RESTORING) {
                KFLog.debug("onStateChange: restoring document");
                return this._pwmgr._fillDocument(domDoc,true);
            }

            // Add event listener to process page when DOM is complete.
            domDoc.addEventListener("DOMContentLoaded",
                                    this._domEventListener, false);
            
            // attempt to refill the forms on the current tab in this window at a regular interval
            // This is to enable manual form filling of sites which generate forms dynamically
            // (i.e. after initial DOM load)
            if (this._pwmgr._kf._keeFoxExtension.prefs.getValue("dynamicFormScanning",false))
                this._pwmgr._refillTimer.init(this._domEventListener, 2500, Components.interfaces.nsITimer.TYPE_REPEATING_SLACK);
            
            KFLog.debug("onStateChange: end");                
            return;
        },
        
        onLocationChange : function(aProgress, aRequest, aURI)
        { 
            KFLog.debug("Location changed: " + aURI.spec);
            // remove all the old logins from the toolbar
            keeFoxToolbar.removeLogins();
         },

        // stubs for the nsIWebProgressListener interfaces which we don't use.
        onProgressChange : function() { throw "Unexpected onProgressChange"; },
        onStatusChange   : function() { throw "Unexpected onStatusChange";   },
        onSecurityChange : function() { throw "Unexpected onSecurityChange"; }
        // onRefreshAttempted(aWebProgress, aURI, aDelay, aSameURI) (needs WebListener2 but could be useful?...)
    },
    

    /*
     * _domEventListener object
     *
     * Internal utility object, implements nsIDOMEventListener
     * Used to catch certain DOM events needed to properly implement form fill.
     */
    _domEventListener : {
        _pwmgr : null,

        QueryInterface : XPCOMUtils.generateQI([Ci.nsIObserver, 
                                                Ci.nsIDOMEventListener,
                                                Ci.nsISupportsWeakReference]),

        // nsObserver
        observe : function (subject, topic, data) {
            var doc;
            switch(topic) {
                case "sessionstore-windows-restored":

                    break;
                case "timer-callback":    
                    //this._pwmgr.log("timer fired");
                    //doc = this._pwmgr._currentWindow.content.document;
                    this._pwmgr._toolbar.setLogins(null, null);
                    this._pwmgr._fillAllFrames(this._pwmgr._currentWindow.content,false);
                    //this._pwmgr._fillDocument(doc,false); //TODO: find some ways of deciding that there is no need to call this function in some cases. E.g. DOMMutation events? but just having those events on a page drops all other DOM performance by > 50% so will be too slow for DOM heavy sites. maybe do one every 2 seconds regardless and some others more frequently only if # of forms has changed?
                    break;

            }

        },

        handleEvent : function (event) {
            KFLog.debug("domEventListener: got event " + event.type);

            var doc, inputElement;
            switch (event.type) {
                case "DOMContentLoaded":
                    doc = event.target;
                    /*
                    var KFTabState = {
        docFillAttemptCount: null
        //TODO: store this to help improve refill feature:
        // number of forms in document
        // form.length = number of control items in a form
        }
        
        KFTabState.docFillAttemptCount = 0;
        
        var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
                                        .getService(Components.interfaces.nsIWindowMediator);
        var newWindow = wm.getMostRecentWindow("navigator:browser");
        var b = newWindow.getBrowser();
        var newTab = b.loadOneTab( actionURL, null, null, null, false, null );
        var ss = Components.classes["@mozilla.org/browser/sessionstore;1"]
                .getService(Components.interfaces.nsISessionStore);

        ss.setTabValue(newTab, "KF_uniqueID", uniqueID);
        ss.setTabValue(newTab, "KF_autoSubmit", "yes");*/
                    KFLog.debug("domEventListener: trying to load form filler");
                    this._pwmgr._fillDocument(doc,true);
                    /*for (var i = 0; i < doc.forms.length; i++) {
                        var form = doc.forms[i];
                        for (var j = 0; j < form.elements.length; j++) {
                            alert(form.elements[j].value);
                        }
                    }*/
                    KFLog.debug("domEventListener: form filler finished");
                    return;
                    
                //case "load":
                    //doc = event.target;
                    //this._pwmgr._fillDocument(doc,true);
                    /*for (var i = 0; i < doc.forms.length; i++) {
                        var form = doc.forms[i];
                        for (var j = 0; j < form.elements.length; j++) {
                            alert(form.elements[j].value);
                        }
                    }*/
                 //   return;

                default:
                    KFLog.warn("This event unexpected.");
                    return;
            }
        }
    },
    
    _isAKnownUsernameString : function (fieldNameIn)
    {
        var fieldName = fieldNameIn.toLowerCase();
        if (fieldName == "username" || fieldName == "j_username" || fieldName == "user_name"
         || fieldName == "user" || fieldName == "user-name" || fieldName == "login"
         || fieldName == "vb_login_username" || fieldName == "name" || fieldName == "user name"
         || fieldName == "user id" || fieldName == "user-id" || fieldName == "userid"
         || fieldName == "email" || fieldName == "e-mail" || fieldName == "id"
         || fieldName == "form_loginname" || fieldName == "wpname" || fieldName == "mail"
         || fieldName == "loginid" || fieldName == "login id") // etc. etc.
            return true;
        return false;
    },

    /*
     * _getFormFields
     *
     * Returns the usernameIndex and password fields found in the form.
     * Can handle complex forms by trying to figure out what the
     * relevant fields are.
     *
     * Returns: [usernameIndex, passwords, ...]
     * all arrays are standard javascript arrays - you may need to convert them to ns arrays...
     * usernameField may be null.
     */
    _getFormFields : function (form, isSubmission, currentTabPage) {
        var DOMusernameField = null;
         var pwFields = [];
         var otherFields = [];
         var allFields = [];
         var firstPasswordIndex = -1;
         var firstPossibleUsernameIndex = -1;
         var usernameIndex = -1;
         var usernameField = null;
        
        var kfLoginField = new Components.Constructor(
            "@christomlinson.name/kfLoginField;1", Ci.kfILoginField);

        // search the DOM for any form fields we might be interested in
        for (var i = 0; i < form.elements.length; i++) {
        
            if (form.elements[i].type == undefined || form.elements[i].type == null)
                continue; // maybe it's a fieldset or something else un-interesting
                
            var DOMtype = form.elements[i].type.toLowerCase();
            
            KFLog.debug("domtype: "+ DOMtype );
            
            //TODO: support select drop downs
            // && DOMtype != "select-one"
            // (this is much more difficult than other form fields so pushing back to 0.8)
            if (DOMtype != "password" && DOMtype != "text" && DOMtype != "checkbox" && DOMtype != "radio")
                continue; // ignoring other form types at the moment
            
            if (DOMtype == "checkbox" && isSubmission && form.elements[i].checked == false) continue;
            if (DOMtype == "radio" && isSubmission && form.elements[i].checked == false) continue;
            
            if (DOMtype == "password" && isSubmission && !form.elements[i].value) continue;
            //if (DOMtype == "select-one" && isSubmission && !form.elements[i].value) continue;
            
KFLog.debug("proccessing...");
            allFields[allFields.length] =
            {
                index   : i,
                element : new kfLoginField,
                type    : DOMtype
            };
            allFields[allFields.length-1].element.init(
                form.elements[i].name, form.elements[i].value, form.elements[i].id, DOMtype, currentTabPage);
            allFields[allFields.length-1].element.DOMInputElement = form.elements[i];
            
            if (DOMtype == "password" && firstPasswordIndex == -1) firstPasswordIndex = allFields.length-1;
            if (DOMtype == "text" && firstPossibleUsernameIndex == -1 && this._isAKnownUsernameString(form.elements[i].name)) firstPossibleUsernameIndex = allFields.length-1;
        }
        KFLog.debug("firstPossibleUsernameIndex: "+ firstPossibleUsernameIndex );
        // work out which DOM form element is most likely to be the username field
        if (firstPossibleUsernameIndex != -1)
            usernameIndex = firstPossibleUsernameIndex;
        else if (firstPasswordIndex > 0)
            usernameIndex = firstPasswordIndex - 1;
        KFLog.debug("usernameIndex: "+ usernameIndex );

        var otherCount = 0;
        var actualUsernameIndex = 0;
        
        // seperate the field data into appropriate variables
        for (var i = 0; i < allFields.length; i++) {
            
            if (allFields[i].type == "password")
                pwFields[pwFields.length] = allFields[i].element;
            else if (allFields[i].type == "text" || allFields[i].type == "checkbox" || allFields[i].type == "radio")
            {
                otherFields[otherFields.length] = allFields[i].element;
                if (i == usernameIndex) 
                    actualUsernameIndex = otherCount;
                else
                    otherCount++;
            }
                
        }
        
        KFLog.debug("actualUsernameIndex: "+ actualUsernameIndex );
        KFLog.debug("otherFields.length:" + otherFields.length);

        return [actualUsernameIndex, pwFields, otherFields];

    },
 
    /*
     * addLogin
     *
     * Add a new login to login storage.
     */
    addLogin : function (login, parentUUID) {
        // Sanity check the login
        if (login.URLs == null || login.URLs.length == 0)
            throw "Can't add a login with a null or empty list of hostnames / URLs.";

        // For logins w/o a username, set to "", not null.
        //if (login.username == null)
        //    throw "Can't add a login with a null username.";

        if (login.passwords == null || login.passwords.length <= 0)
            throw "Can't add a login with a null or empty list of passwords.";

        if (login.formActionURL || login.formActionURL == "") {
            // We have a form submit URL. Can't have a HTTP realm.
            if (login.httpRealm != null)
                throw "Can't add a login with both a httpRealm and formSubmitURL.";
        } else if (login.httpRealm) {
            // We have a HTTP realm. Can't have a form submit URL.
            if (login.formActionURL != null)
                throw "Can't add a login with both a httpRealm and formSubmitURL.";
        } else {
            // Need one or the other!
            throw "Can't add a login without a httpRealm or formSubmitURL.";
        }

        var primaryURL = "";

        // Look for an existing entry.
        // NB: maybe not ideal - would be nice to search for all URLs in
        // one go but in practice this will affect performance only rarely
        for (i = 0; i < login.URLs.length; i++)
        {
            // Unfortunately the container is declared to have elements
            // that are generic nsIMutableArray. So, we must QI...
            var loginURL = login.URLs.queryElementAt(i,Components.interfaces.kfIURL);
          
            var logins = this.findLogins({}, loginURL.URL, login.formActionURL,
                                     login.httpRealm);

            if (logins.some(function(l) login.matches(l, false, false, false, false)))
            {
                KFLog.info("This login already exists.");
                return "This login already exists.";
            }
            
            if (i == 0)
                primaryURL = loginURL.URL;
        }
        
        if (this._kf._keeFoxExtension.prefs.getValue("saveFavicons",false))
        {
            try {
                login.iconImageData = this._kf.loadFavicon(primaryURL);
            } catch (ex) 
            {
                // something failed so we can't get the favicon. We don't really mind too much...
            }
        }
        
        KFLog.info("Adding login to group: " + parentUUID);
        return this._kf.addLogin(login, parentUUID);
    },
    
    /*
     * addGroup
     *
     * Add a new group to the KeePass database
     */
    addGroup : function (title, parentUUID) {
        // Sanity check the login
        if (title == null || title.length == 0)
            throw "Can't add a group with no title.";


        KFLog.info("Adding group: " + title + " to group: " + parentUUID);
        return this._kf.addGroup(title, parentUUID);
    },
    
    getParentGroup : function (uniqueID) {
        KFLog.debug("Getting parent group of: " + uniqueID);
        return this._kf.getParentGroup(uniqueID);
    },
    
    getRootGroup : function () {
        KFLog.debug("Getting root group");
        return this._kf.getRootGroup();
    },
    
    getChildGroups : function (count, uniqueID) {
        KFLog.debug("Getting all child groups of: " + uniqueID);
        return this._kf.getChildGroups(count, uniqueID);
    },
    
    getChildEntries : function (count, uniqueID) {
        KFLog.debug("Getting all child entries of: " + uniqueID);
        return this._kf.getChildEntries(count, uniqueID);
    },
    
    

    /*
     * removeLogin
     *
     * Remove the specified login from the stored logins.
     */
    removeLogin : function (uniqueID) {
        KFLog.info("Removing login: " + uniqueID);
        return this._kf.removeLogin(uniqueID);
    },
    
    /*
     * removeGroup
     *
     * Remove the specified group and its contents from the KeePass DB.
     */
    removeGroup : function (uniqueID) {
        KFLog.info("Removing group: " + uniqueID);
        return this._kf.removeGroup(uniqueID);
    },


    /*
     * modifyLogin
     *
     * Change the specified login to match the new login.
     */
    modifyLogin : function (oldLogin, newLogin) {
        KFLog.info("Modifying a login");
        return this._kf.modifyLogin(oldLogin, newLogin);
    },


    /*
     * getAllLogins
     *
     * Get a dump of all stored logins. Used by the login manager UI.
     *
     * |count| is only needed for XPCOM.
     *
     * Returns an array of logins. If there are no logins, the array is empty.
     */
    getAllLogins : function (count) {
        KFLog.debug("Getting a list of all logins");
        return this._kf.getAllLogins(count);
    },
        
    /*
     * findLogins
     *
     * Search for the known logins for entries matching the specified criteria.
     */
    findLogins : function (count, url, formSubmitURL, httpRealm, uniqueID) {
        if (KFLog.logSensitiveData)
            KFLog.info("Searching for logins matching URL: " + url +
            ", formSubmitURL: " + formSubmitURL + ", httpRealm: " + httpRealm
             + ", uniqueID: " + uniqueID);
        else
            KFLog.info("Searching for logins");

        return this._kf.findLogins(count, url, formSubmitURL, httpRealm, uniqueID);
    },
    
    countLogins : function (hostName,actionURL,loginSearchType)
    {
        
        if (this._kf._keeFoxStorage.get("KeeICEActive",false))
        {
            return this._kf.countLogins(hostName,actionURL,loginSearchType);
        }
    },

    /*
     * _getURIExcludingQS
     *
     * Get a string that incldues all but a URI's query string
     */
    _getURIExcludingQS : function (uriString) {

        var realm = "";
        try {
            var uri = this._ioService.newURI(uriString, null, null);

            if (uri.scheme == "file")
                realm = uri.scheme + "://";
            else
            {
                realm = uri.scheme + "://" + uri.host;

                // If the URI explicitly specified a port, only include it when
                // it's not the default. (We never want "http://foo.com:80")
                var port = uri.port;
                if (port != -1) {
                    var handler = this._ioService.getProtocolHandler(uri.scheme);
                    if (port != handler.defaultPort)
                        realm += ":" + port;
                }
            }
            
            var QSbreak = uri.path.indexOf('?');
            
            realm += uri.path.substring(1,QSbreak > 1 ? QSbreak : uri.path.length);
            

        } catch (e) {
            if (KFLog.logSensitiveData)
                KFLog.error("Couldn't parse origin for " + uriString);
            else
                KFLog.error("Couldn't parse origin");
            realm = null;
        }
        return realm;
    },
    
    /*
     * _getURIHostAndPort
     *
     * Get a string that includes only a URI's host and port.
     * EXCEPTION: For file protocol this returns the file path
     */
    _getURIHostAndPort : function (uriString) {

        var realm = "";
        try {
            var uri = this._ioService.newURI(uriString, null, null);

            if (uri.scheme == "file")
                realm = uri.path;
            else
            {
                realm = uri.host;

                // If the URI explicitly specified a port, only include it when
                // it's not the default. (We never want "http://foo.com:80")
                var port = uri.port;
                if (port != -1) {
                    var handler = this._ioService.getProtocolHandler(uri.scheme);
                    if (port != handler.defaultPort)
                        realm += ":" + port;
                }
            }

        } catch (e) {
            if (KFLog.logSensitiveData)
                KFLog.error("Couldn't parse origin for " + uriString);
            else
                KFLog.error("Couldn't parse origin");
            realm = null;
        }
        return realm;
    },
    
    /*
     * _getURISchemeHostAndPort
     *
     * Get a string that includes only a URI's scheme, host and port
     * EXCEPTION: For file protocol this returns the file scheme and path
     */
    _getURISchemeHostAndPort : function (uriString) {

        var realm = "";
        try {
            var uri = this._ioService.newURI(uriString, null, null);
            
            if (uri.scheme == "file")
                realm = uri.scheme + "://" + uri.path;
            else
            {
                realm = uri.scheme + "://" + uri.host;

                // If the URI explicitly specified a port, only include it when
                // it's not the default. (We never want "http://foo.com:80")
                var port = uri.port;
                if (port != -1) {
                    var handler = this._ioService.getProtocolHandler(uri.scheme);
                    if (port != handler.defaultPort)
                        realm += ":" + port;
                }
            }

        } catch (e) {
            if (KFLog.logSensitiveData)
                KFLog.error("Couldn't parse origin for " + uriString);
            else
                KFLog.error("Couldn't parse origin");
            realm = null;
        }
        if (KFLog.logSensitiveData) KFLog.debug("_getURISchemeHostAndPort:"+realm);
        return realm;
    },
    
    /*
     * _getURIScheme
     *
     * Get a string that includes only a URI's scheme
     */
    _getURIScheme : function (uriString) {

        try {
            var uri = this._ioService.newURI(uriString, null, null);
            
            return uri.scheme;

        } catch (e) {
            if (KFLog.logSensitiveData)
                KFLog.error("Couldn't parse scheme for " + uriString);
            else
                KFLog.error("Couldn't parse scheme");
            return "unknown";
        }
    },
    
    /*
     * _getPasswordOrigin
     *
     * Get the parts of the URL we want for identification.
     */
    _getPasswordOrigin : function (uriString, allowJS) {
    
        // temporarily(?) returning the URI string as is - if it needs to
        // be trimmed to host and port this will be done in KeeICE
        return uriString;
    
        var realm = "";
        try {
            var uri = this._ioService.newURI(uriString, null, null);

            if (allowJS && uri.scheme == "javascript")
                return "javascript:"

            realm = uri.scheme + "://" + uri.host;

            // If the URI explicitly specified a port, only include it when
            // it's not the default. (We never want "http://foo.com:80")
            var port = uri.port;
            if (port != -1) {
                var handler = this._ioService.getProtocolHandler(uri.scheme);
                if (port != handler.defaultPort)
                    realm += ":" + port;
            }

        } catch (e) {
            // bug 159484 - disallow url types that don't support a hostPort.
            // (although we handle "javascript:..." as a special case above.)
            if (KFLog.logSensitiveData)
                KFLog.error("Couldn't parse origin for " + uriString);
            else
                KFLog.error("Couldn't parse origin");
            realm = null;
        }
        return realm;
    },
    
    
    _getActionOrigin : function (form) {
        var uriString = form.action;

        // A blank or mission action submits to where it came from.
        if (uriString == "")
            uriString = form.baseURI;
        return this._getPasswordOrigin(uriString, true);
    },
    
    
    
    loadAndAutoSubmit : function (usernameName,usernameValue,actionURL,usernameID,formID,uniqueID) {
        KFLog.debug("loadAndAutoSubmit");
        
        var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
                                        .getService(Components.interfaces.nsIWindowMediator);
        var newWindow = wm.getMostRecentWindow("navigator:browser");
        var b = newWindow.getBrowser();
        var newTab = b.loadOneTab( actionURL, null, null, null, false, null );
        newTab.setAttribute("KF_uniqueID", uniqueID);
        newTab.setAttribute("KF_autoSubmit", "yes");

        
        //TODO: this is not allowed becuase the tab has most likely not loaded yet! need to register a callback function!
        //var ss = Components.classes["@mozilla.org/browser/sessionstore;1"]
        //        .getService(Components.interfaces.nsISessionStore);

       // ss.setTabValue(newTab, "KF_uniqueID", uniqueID);
       // ss.setTabValue(newTab, "KF_autoSubmit", "yes");
    }//,
    
    
    //_generateFormLogin : function (URL, formActionURL, title, usernameIndex, passwordFields, otherFields, maxPageCount)
    //{
    //    var formLogin = new this._kfLoginInfo();
    
      /*  if (otherFields != null && otherFields != undefined)
        {
            formLogin.initOther(URL, formActionURL, null,
                usernameIndex,
                passwordFields, null, title, otherFields);
            this.log("login object initialised with custom data");
        } else
        {*/
     //       formLogin.init(URL, formActionURL, null,
     //           usernameIndex,
     //           passwordFields, null, title, otherFields, maxPageCount);
       /*     this.log("login object initialised without custom data");
        }*/
        
     //   return formLogin;
    //}
    
    
    
   };
   
   
var loader = Components.classes["@mozilla.org/moz/jssubscript-loader;1"]
                       .getService(Components.interfaces.mozIJSSubScriptLoader); 
loader.loadSubScript("resource://kfscripts/KFILM_Fill.js");   
loader.loadSubScript("resource://kfscripts/KFILM_Submit.js");   
   