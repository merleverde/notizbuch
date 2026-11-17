'use strict';
/* Verbindung zur Android-App (android/…/MainActivity.java).
   Läuft die Web-App im normalen Browser, gibt es window.AndroidBridge nicht und diese Datei tut nichts.
   In der App ersetzt sie die Datei-Funktionen des Browsers (showOpenFilePicker …) durch den
   Android-Speicherzugriff. app.js merkt davon nichts und benutzt dieselben Aufrufe wie in Chrome. */
(function () {
  const B = window.AndroidBridge;
  if (!B) return;

  // Anfragen an Android laufen asynchron; die Antwort kommt über __nb.done(id, ergebnis)
  const pending = new Map();
  let seq = 0;
  window.__nb = {
    done(id, res) {
      const p = pending.get(id); if (!p) return;
      pending.delete(id);
      if (res && res.error) p.reject(Object.assign(new Error(res.error), { name: res.name || 'Error' }));
      else p.resolve(res || {});
    }
  };
  const call = (fn, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    B[fn](id, ...args);
  });

  function b64ToBytes(b64) {
    const s = atob(b64), u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }
  function bytesToB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /* Ersatz für FileSystemFileHandle. Nur uri/name/writable sind eigene Daten,
     damit der Griff in IndexedDB gespeichert werden kann (reviveHandle macht ihn wieder benutzbar). */
  class NativeFileHandle {
    constructor(o) { this.kind = 'file'; this.native = true; this.uri = o.uri; this.name = o.name; this.writable = o.writable !== false; }
    async getFile() {
      const r = await call('readUri', this.uri);
      return new File([b64ToBytes(r.b64)], this.name, { type: r.mime || '' });
    }
    async queryPermission() { return this.writable ? 'granted' : 'denied'; }
    async requestPermission() { return this.queryPermission(); }
    async size() { return (await call('sizeUri', this.uri)).size; }
    async createWritable() {
      const h = this, parts = [];
      return {
        async write(d) { parts.push(d instanceof Blob ? d : new Blob([d])); },
        async close() {
          const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
          const r = await call('writeUri', h.uri, bytesToB64(buf));
          h.lastWritten = r.written;
        },
        async abort() { parts.length = 0; }        // es wurde noch nichts geschrieben: die alte Datei bleibt
      };
    }
    async isSameEntry(o) { return !!o && o.uri === this.uri; }
    async remove() { await call('deleteUri', this.uri); }
  }
  window.NativeFileHandle = NativeFileHandle;
  window.reviveHandle = h => (h && h.native && !(h instanceof NativeFileHandle)) ? new NativeFileHandle(h) : h;

  const mimesOf = types => [...new Set((types || []).flatMap(t => Object.keys(t.accept || {})))];
  window.showOpenFilePicker = async (o = {}) => [new NativeFileHandle(await call('openDocument', JSON.stringify(mimesOf(o.types))))];
  window.showSaveFilePicker = async (o = {}) => new NativeFileHandle(await call('createDocument', o.suggestedName || 'Notiz.pdf', mimesOf(o.types)[0] || 'application/octet-stream'));

  // Bildschirm wach halten und Vibration über Android (die WebView kann beides nicht selbst)
  try {
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: async () => { B.keepAwake(true); return { release: async () => B.keepAwake(false) }; } }
    });
  } catch {}
  navigator.vibrate = ms => { B.vibrate(Array.isArray(ms) ? ms[0] : (ms | 0)); return true; };

  window.NATIVE_APP = {
    version: B.appVersion(),
    versionCode: B.appVersionCode ? B.appVersionCode() : 0,
    // Updates: version.json von der GitHub-Seite lesen bzw. neue APK laden und installieren
    checkUpdate: url => call('checkUpdate', url || ''),
    installUpdate: url => call('installUpdate', url)
  };
})();
