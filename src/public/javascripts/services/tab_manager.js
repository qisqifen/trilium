import Component from "../widgets/component.js";
import SpacedUpdate from "./spaced_update.js";
import server from "./server.js";
import options from "./options.js";
import treeCache from "./tree_cache.js";
import treeService from "./tree.js";
import utils from "./utils.js";
import TabContext from "./tab_context.js";

export default class TabManager extends Component {
    constructor() {
        super();

        this.activeTabId = null;

        this.tabsUpdate = new SpacedUpdate(async () => {
            const openTabs = this.tabContexts
                .map(tc => tc.getTabState())
                .filter(t => !!t);

            await server.put('options', {
                openTabs: JSON.stringify(openTabs)
            });
        });
    }

    /** @type {TabContext[]} */
    get tabContexts() {
        return this.children;
    }

    async loadTabs() {
        const openTabs = options.getJson('openTabs') || [];

        await treeCache.initializedPromise;

        // if there's notePath in the URL, make sure it's open and active
        // (useful, among others, for opening clipped notes from clipper)
        if (window.location.hash) {
            const notePath = window.location.hash.substr(1);
            const noteId = treeService.getNoteIdFromNotePath(notePath);

            if (noteId && await treeCache.noteExists(noteId)) {
                for (const tab of openTabs) {
                    tab.active = false;
                }

                const foundTab = openTabs.find(tab => noteId === treeService.getNoteIdFromNotePath(tab.notePath));

                if (foundTab) {
                    foundTab.active = true;
                }
                else {
                    openTabs.push({
                        notePath: notePath,
                        active: true
                    });
                }
            }
        }

        let filteredTabs = [];

        for (const openTab of openTabs) {
            const noteId = treeService.getNoteIdFromNotePath(openTab.notePath);

            if (await treeCache.noteExists(noteId)) {
                // note doesn't exist so don't try to open tab for it
                filteredTabs.push(openTab);
            }
        }

        if (utils.isMobile()) {
            // mobile frontend doesn't have tabs so show only the active tab
            filteredTabs = filteredTabs.filter(tab => tab.active);
        }

        if (filteredTabs.length === 0) {
            filteredTabs.push({
                notePath: 'root',
                active: true
            });
        }

        if (!filteredTabs.find(tab => tab.active)) {
            filteredTabs[0].active = true;
        }

        await this.tabsUpdate.allowUpdateWithoutChange(async () => {
            for (const tab of filteredTabs) {
                await this.openTabWithNote(tab.notePath, tab.active, tab.tabId);
            }
        });
    }

    tabNoteSwitchedEvent({tabId}) {
        if (tabId === this.activeTabId) {
            this.setCurrentNotePathToHash();
        }

        this.tabsUpdate.scheduleUpdate();
    }

    setCurrentNotePathToHash() {
        const activeTabContext = this.getActiveTabContext();

        if (activeTabContext
            && activeTabContext.notePath !== treeService.getHashValueFromAddress()) {
            const url = '#' + (activeTabContext.notePath || "") + "-" + activeTabContext.tabId;

            // using pushState instead of directly modifying document.location because it does not trigger hashchange
            window.history.pushState(null, "", url);

            document.title = "Trilium Notes";

            if (activeTabContext.note) {
                // it helps navigating in history if note title is included in the title
                document.title += " - " + activeTabContext.note.title;
            }
        }
    }

    /** @return {TabContext[]} */
    getTabContexts() {
        return this.tabContexts;
    }

    /** @returns {TabContext} */
    getTabContextById(tabId) {
        return this.tabContexts.find(tc => tc.tabId === tabId);
    }

    /** @returns {TabContext} */
    getActiveTabContext() {
        return this.getTabContextById(this.activeTabId);
    }

    /** @returns {string|null} */
    getActiveTabNotePath() {
        const activeContext = this.getActiveTabContext();
        return activeContext ? activeContext.notePath : null;
    }

    /** @return {NoteShort} */
    getActiveTabNote() {
        const activeContext = this.getActiveTabContext();
        return activeContext ? activeContext.note : null;
    }

    /** @return {string|null} */
    getActiveTabNoteId() {
        const activeNote = this.getActiveTabNote();

        return activeNote ? activeNote.noteId : null;
    }

    /** @return {string|null} */
    getActiveTabNoteType() {
        const activeNote = this.getActiveTabNote();

        return activeNote ? activeNote.type : null;
    }

    async switchToTab(tabId, notePath) {
        const tabContext = this.tabContexts.find(tc => tc.tabId === tabId)
            || this.openEmptyTab();

        this.activateTab(tabContext.tabId);
        await tabContext.setNote(notePath);
    }

    async openAndActivateEmptyTab() {
        const tabContext = this.openEmptyTab();

        await this.activateTab(tabContext.tabId);

        await tabContext.setEmpty();
    }

    openEmptyTab(tabId) {
        const tabContext = new TabContext(tabId);
        this.child(tabContext);

        this.triggerEvent('newTabOpened', {tabId: tabContext.tabId});

        return tabContext;
    }

    async openTabWithNote(notePath, activate, tabId = null) {
        const tabContext = this.openEmptyTab(tabId);

        await tabContext.setNote(notePath, !activate); // if activate is false then send normal noteSwitched event

        if (activate) {
            this.activateTab(tabContext.tabId, false);

            this.triggerEvent('tabNoteSwitchedAndActivated', {
                tabId: tabContext.tabId,
                notePath
            });
        }
    }

    async activateOrOpenNote(noteId) {
        for (const tabContext of this.getTabContexts()) {
            if (tabContext.note && tabContext.note.noteId === noteId) {
                await tabContext.activate();
                return;
            }
        }

        // if no tab with this note has been found we'll create new tab

        const tabContext = this.openEmptyTab();
        await tabContext.setNote(noteId);
    }

    activateTab(tabId, triggerEvent = true) {
        if (tabId === this.activeTabId) {
            return;
        }

        this.activeTabId = tabId;

        if (triggerEvent) {
            this.triggerEvent('activeTabChanged');
        }

        this.tabsUpdate.scheduleUpdate();
        
        this.setCurrentNotePathToHash();
    }

    async removeTab(tabId) {
        const tabContextToRemove = this.getTabContextById(tabId);

        if (!tabContextToRemove) {
            return;
        }

        await this.triggerEvent('beforeTabRemove', {tabId}, true);

        if (this.tabContexts.length <= 1) {
            this.openAndActivateEmptyTab();
        }
        else if (tabContextToRemove.isActive()) {
            this.activateNextTabCommand();
        }

        this.children = this.children.filter(tc => tc.tabId !== tabId);

        this.triggerEvent('tabRemoved', {tabId});

        this.tabsUpdate.scheduleUpdate();
    }

    tabReorderEvent({tabIdsInOrder}) {
        const order = {};

        for (const i in tabIdsInOrder) {
            order[tabIdsInOrder[i]] = i;
        }

        this.children.sort((a, b) => order[a.tabId] < order[b.tabId] ? -1 : 1);

        this.tabsUpdate.scheduleUpdate();
    }

    activateNextTabCommand() {
        const oldIdx = this.tabContexts.findIndex(tc => tc.tabId === this.activeTabId);
        const newActiveTabId = this.tabContexts[oldIdx === this.tabContexts.length - 1 ? 0 : oldIdx + 1].tabId;

        this.activateTab(newActiveTabId);
    }

    activatePreviousTabCommand() {
        const oldIdx = this.tabContexts.findIndex(tc => tc.tabId === this.activeTabId);
        const newActiveTabId = this.tabContexts[oldIdx === 0 ? this.tabContexts.length - 1 : oldIdx - 1].tabId;

        this.activateTab(newActiveTabId);
    }

    closeActiveTabCommand() {
        this.removeTab(this.activeTabId);
    }

    beforeUnloadEvent() {
        this.tabsUpdate.updateNowIfNecessary();
    }

    openNewTabCommand() {
        this.openAndActivateEmptyTab();
    }

    async removeAllTabsCommand() {
        for (const tabIdToRemove of this.tabContexts.map(tc => tc.tabId)) {
            await this.removeTab(tabIdToRemove);
        }
    }

    async removeAllTabsExceptForThisCommand({tabId}) {
        for (const tabIdToRemove of this.tabContexts.map(tc => tc.tabId)) {
            if (tabIdToRemove !== tabId) {
                await this.removeTab(tabIdToRemove);
            }
        }
    }

    async hoistedNoteChangedEvent({hoistedNoteId}) {
        if (hoistedNoteId === 'root') {
            return;
        }

        for (const tc of this.tabContexts.splice()) {
            if (tc.notePath && !tc.notePath.split("/").includes(hoistedNoteId)) {
                await this.removeTab(tc.tabId);
            }
        }
    }
}