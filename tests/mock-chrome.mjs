// Stateful mock of the chrome.* extension APIs used by Tab Vault.
// Good enough to exercise the storage / snapshot / restore logic against a
// realistic synthetic browser state.

class EventBus {
  constructor() { this.listeners = []; }
  addListener(fn) { this.listeners.push(fn); }
  removeListener(fn) { this.listeners = this.listeners.filter(f => f !== fn); }
  emit(...args) { for (const l of this.listeners) l(...args); }
}

export function createMockChrome() {
  const state = {
    storage: new Map(),
    windows: new Map(),
    nextWindowId: 1,
    nextTabId: 1,
    nextGroupId: 1,
    alarms: new Map(),
    badgeText: '',
    badgeColor: ''
  };

  // ---- chrome.storage.local ----
  const storage = {
    local: {
      get(keys, cb) {
        let result = {};
        if (keys == null) {
          for (const [k, v] of state.storage) result[k] = v;
        } else if (typeof keys === 'string') {
          if (state.storage.has(keys)) result[keys] = state.storage.get(keys);
        } else if (Array.isArray(keys)) {
          for (const k of keys) if (state.storage.has(k)) result[k] = state.storage.get(k);
        } else if (typeof keys === 'object') {
          for (const k of Object.keys(keys)) {
            result[k] = state.storage.has(k) ? state.storage.get(k) : keys[k];
          }
        }
        if (cb) cb(result);
        return Promise.resolve(result);
      },
      set(items, cb) {
        for (const k of Object.keys(items)) state.storage.set(k, items[k]);
        if (cb) cb();
        return Promise.resolve();
      },
      remove(keys, cb) {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) state.storage.delete(k);
        if (cb) cb();
        return Promise.resolve();
      },
      clear(cb) {
        state.storage.clear();
        if (cb) cb();
        return Promise.resolve();
      },
      getBytesInUse(keys, cb) {
        let total = 0;
        for (const [k, v] of state.storage) {
          total += k.length + JSON.stringify(v ?? null).length;
        }
        if (cb) cb(total);
        return Promise.resolve(total);
      }
    }
  };

  // ---- chrome.windows ----
  const windowsEvents = {
    onCreated: new EventBus(),
    onRemoved: new EventBus(),
    onFocusChanged: new EventBus()
  };
  const windows = {
    ...windowsEvents,
    async getAll({ populate } = {}) {
      const wins = [...state.windows.values()].map(w => populate ? cloneWithTabs(w) : { ...w });
      return wins;
    },
    async get(windowId, { populate } = {}) {
      const w = state.windows.get(windowId);
      if (!w) throw new Error('No window with id ' + windowId);
      return populate ? cloneWithTabs(w) : { ...w };
    },
    async getCurrent() {
      for (const w of state.windows.values()) if (w.focused) return cloneWithTabs(w);
      const first = [...state.windows.values()][0];
      return first ? cloneWithTabs(first) : null;
    },
    async create({ url, focused = true, state: winState = 'normal', top, left, width, height } = {}) {
      const id = state.nextWindowId++;
      const urls = Array.isArray(url) ? url : (url ? [url] : []);
      const tabs = urls.map((u, i) => ({
        id: state.nextTabId++,
        windowId: id,
        url: u,
        title: u,
        index: i,
        pinned: false,
        active: i === 0,
        groupId: -1,
        favIconUrl: ''
      }));
      const w = { id, focused: !!focused, state: winState, type: 'normal', tabs, top, left, width, height, incognito: false };
      state.windows.set(id, w);
      windowsEvents.onCreated.emit({ ...w });
      return cloneWithTabs(w);
    },
    async remove(windowId) {
      state.windows.delete(windowId);
      windowsEvents.onRemoved.emit(windowId);
    }
  };

  // ---- chrome.tabs ----
  const tabsEvents = {
    onCreated: new EventBus(),
    onRemoved: new EventBus(),
    onUpdated: new EventBus(),
    onMoved:   new EventBus(),
    onAttached: new EventBus(),
    onDetached: new EventBus(),
    onReplaced: new EventBus(),
    onActivated: new EventBus()
  };
  const tabs = {
    ...tabsEvents,
    async create({ windowId, url, active = false, pinned = false } = {}) {
      const w = state.windows.get(windowId);
      if (!w) throw new Error('No window with id ' + windowId);
      const t = {
        id: state.nextTabId++,
        windowId,
        url, title: url, index: w.tabs.length,
        pinned, active, groupId: -1, favIconUrl: ''
      };
      w.tabs.push(t);
      tabsEvents.onCreated.emit({ ...t });
      return { ...t };
    },
    async update(tabId, updates) {
      const t = findTab(tabId);
      if (!t) throw new Error('No tab ' + tabId);
      if (updates.pinned !== undefined) {
        t.pinned = updates.pinned;
        // Pinning moves tab to leftmost unpinned position (i.e. after other pinned).
        const w = state.windows.get(t.windowId);
        w.tabs.splice(w.tabs.indexOf(t), 1);
        if (updates.pinned) {
          const firstUnpinned = w.tabs.findIndex(x => !x.pinned);
          const ins = firstUnpinned < 0 ? w.tabs.length : firstUnpinned;
          w.tabs.splice(ins, 0, t);
        } else {
          w.tabs.push(t);
        }
        reindex(w);
      }
      if (updates.active !== undefined) {
        const w = state.windows.get(t.windowId);
        if (updates.active) { for (const x of w.tabs) x.active = (x.id === t.id); }
      }
      if (updates.muted !== undefined) {
        t.mutedInfo = { muted: !!updates.muted };
      }
      tabsEvents.onUpdated.emit(tabId, updates, { ...t });
      return { ...t };
    },
    async group({ tabIds, createProperties }) {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      const newGroupId = state.nextGroupId++;
      const windowId = createProperties?.windowId ?? findTab(ids[0])?.windowId;
      for (const id of ids) {
        const t = findTab(id);
        if (!t) continue;
        if (t.pinned) throw new Error('Cannot group a pinned tab (id ' + id + ')');
        t.groupId = newGroupId;
      }
      if (!state.tabGroups) state.tabGroups = new Map();
      state.tabGroups.set(newGroupId, { id: newGroupId, title: '', color: 'grey', collapsed: false, windowId });
      tabGroupsEvents.onCreated.emit({ id: newGroupId, title: '', color: 'grey', collapsed: false, windowId });
      return newGroupId;
    }
  };

  // ---- chrome.tabGroups ----
  const tabGroupsEvents = {
    onCreated: new EventBus(),
    onUpdated: new EventBus(),
    onRemoved: new EventBus(),
    onMoved:   new EventBus()
  };
  const tabGroups = {
    ...tabGroupsEvents,
    async query({ windowId } = {}) {
      const all = state.tabGroups ? [...state.tabGroups.values()] : [];
      return windowId != null ? all.filter(g => g.windowId === windowId) : all;
    },
    async update(groupId, updates) {
      const g = state.tabGroups?.get(groupId);
      if (!g) throw new Error('No group ' + groupId);
      Object.assign(g, updates);
      tabGroupsEvents.onUpdated.emit({ ...g });
      return { ...g };
    }
  };

  // ---- chrome.alarms ----
  const alarmsEvents = { onAlarm: new EventBus() };
  const alarms = {
    ...alarmsEvents,
    async create(name, alarmInfo) {
      state.alarms.set(name, alarmInfo);
    },
    async clear(name) {
      return state.alarms.delete(name);
    },
    async getAll() {
      return [...state.alarms.entries()].map(([name, info]) => ({ name, ...info }));
    },
    // helper for tests
    _fire(name) { alarmsEvents.onAlarm.emit({ name }); }
  };

  // ---- chrome.runtime ----
  const runtime = {
    lastError: null,
    onInstalled: new EventBus(),
    onStartup: new EventBus(),
    onMessage: new EventBus(),
    openOptionsPage: () => {},
    sendMessage: () => {}
  };

  // ---- chrome.commands ----
  const commands = { onCommand: new EventBus() };

  // ---- chrome.action ----
  const action = {
    async setBadgeText({ text }) { state.badgeText = text || ''; },
    async setBadgeBackgroundColor({ color }) { state.badgeColor = color || ''; }
  };

  function findTab(tabId) {
    for (const w of state.windows.values()) {
      for (const t of w.tabs) if (t.id === tabId) return t;
    }
    return null;
  }
  function reindex(w) { w.tabs.forEach((t, i) => { t.index = i; }); }
  function cloneWithTabs(w) {
    return { ...w, tabs: w.tabs.map(t => ({ ...t })) };
  }

  // ---- test helpers ----
  function seedWindow({ tabs: rawTabs = [], groups: rawGroups = [], focused = false, state: winState = 'normal', top = 0, left = 0, width = 1280, height = 800 } = {}) {
    const id = state.nextWindowId++;
    const tabs = rawTabs.map((t, i) => ({
      id: state.nextTabId++,
      windowId: id,
      url: t.url,
      title: t.title || t.url,
      index: i,
      pinned: !!t.pinned,
      active: !!t.active,
      groupId: t.groupId ?? -1,
      favIconUrl: t.favIconUrl || ''
    }));
    state.windows.set(id, { id, focused, state: winState, type: 'normal', tabs, top, left, width, height, incognito: false });
    if (!state.tabGroups) state.tabGroups = new Map();
    for (const g of rawGroups) {
      state.tabGroups.set(g.id, { id: g.id, title: g.title || '', color: g.color || 'grey', collapsed: !!g.collapsed, windowId: id });
    }
    return id;
  }
  function reset() {
    state.storage.clear();
    state.windows.clear();
    state.tabGroups = new Map();
    state.alarms.clear();
    state.nextWindowId = 1;
    state.nextTabId = 1;
    state.nextGroupId = 1;
  }

  return {
    chromeApi: { storage, windows, tabs, tabGroups, alarms, runtime, commands, action },
    state,
    seedWindow,
    reset
  };
}
