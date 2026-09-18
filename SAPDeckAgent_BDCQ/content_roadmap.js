// SAP Deck Agent v27.1 — content_roadmap.js
// Runs on me.sap.com/roadmapviewer/*
// NOTE: scanning is now done via executeScript from background.js for reliability.
// This file stays as a lightweight forwarder for fetchAcceleratorFile requests.

(function () {
  'use strict';

  // Chunked base64 encoder — avoids stack overflow on large xlsx files
  async function fetchFileAsBase64(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + resp.statusText);
    const buf   = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const CHUNK = 8192;
    let b64 = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      b64 += btoa(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
    }
    return b64;
  }

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.action === 'fetchAcceleratorFile' || msg.action === 'fetchFileBytes') {
      fetchFileAsBase64(msg.url)
        .then(base64 => respond({ ok: true, base64 }))
        .catch(e     => respond({ ok: false, error: e.message }));
      return true; // keep channel open for async response
    }
  });

})();
