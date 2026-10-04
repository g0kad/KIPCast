'use strict';
/*
 * Keeps KIP's embedded web pages (the Embed Webpage widget, e.g. AvNav)
 * running when you change dashboard.
 *
 * KIP rebuilds a dashboard's widgets each time it's shown, so an embedded
 * page normally starts again from scratch every time you come back to it.
 * This runs in KIP's page before KIP does. When KIP removes a widget with an
 * embedded page, the page's iframe is moved aside, out of sight, instead of
 * being destroyed; when KIP makes an iframe for the same address again, the
 * kept one is put back in its place. Element.moveBefore() moves an iframe
 * without reloading it (Chromium 133 and later). Without it, nothing changes.
 *
 * keepEmbeds is serialised and run in the page, so it can't use anything
 * from outside itself.
 */
function keepEmbeds() {
  if (window.top !== window || typeof Element.prototype.moveBefore !== 'function') return;

  const parked = new Set();   // kept iframes waiting for their widget to come back
  let lot = null;             // where they wait: in the page, but out of sight

  // An iframe of KIP's Embed Webpage widget, as KIP made it. Replacements
  // KIP still holds on to after a kept iframe took their place don't count.
  const isEmbed = (el) => el && el.localName === 'iframe' && el.classList.contains('widgetIframe') && !el.kipcastSpare;

  // Moves the embedded pages in a subtree KIP is about to remove out of it.
  function park(root) {
    if (!root || !root.isConnected || !root.getElementsByTagName) return;
    const frames = root.localName === 'iframe' ? [root] : [...root.getElementsByTagName('iframe')];
    for (const f of frames) {
      if (!isEmbed(f) || !f.getAttribute('src') || !document.body) continue;
      if (!lot) {
        lot = document.createElement('div');
        lot.id = 'kipcast-kept-embeds';
        lot.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;' +
          'visibility:hidden;pointer-events:none;z-index:-1';
        document.body.appendChild(lot);
      }
      // Keep its size, so the page doesn't re-lay itself out while it waits.
      const r = f.getBoundingClientRect();
      const holder = document.createElement('div');
      holder.style.cssText = `width:${Math.max(r.width, 1)}px;height:${Math.max(r.height, 1)}px`;
      lot.appendChild(holder);
      try {
        holder.moveBefore(f, null);
      } catch {
        lot.removeChild(holder);
        continue;
      }
      f.kipcastKept = true;
      parked.add(f);
    }
  }

  // A new iframe from KIP: if one for the same address is waiting, it takes
  // the new one's place.
  function restore(fresh) {
    if (!parked.size || !isEmbed(fresh) || fresh.kipcastKept || !fresh.isConnected) return;
    const src = fresh.getAttribute('src');
    const kept = src && [...parked].find((f) => f.getAttribute('src') === src);
    if (!kept) return;
    const holder = kept.parentNode;
    try {
      fresh.parentNode.moveBefore(kept, fresh);
    } catch {
      return;
    }
    parked.delete(kept);
    holder.remove();
    fresh.kipcastSpare = true;
    fresh.remove();
    // KIP still sets the address on the one it made. Pass changes on.
    new MutationObserver(() => {
      const next = fresh.getAttribute('src');
      if (next && next !== kept.getAttribute('src')) kept.setAttribute('src', next);
    }).observe(fresh, { attributes: true, attributeFilter: ['src'] });
  }

  // KIP (Angular and gridstack) removes widgets with these.
  const before = (proto, name, target) => {
    const orig = proto[name];
    proto[name] = function (...args) {
      try { park(target(this, args)); } catch { /* never get in KIP's way */ }
      return orig.apply(this, args);
    };
  };
  before(Element.prototype, 'remove', (self) => self);
  before(Element.prototype, 'replaceWith', (self) => self);
  before(Node.prototype, 'removeChild', (self, [child]) => child);
  before(Node.prototype, 'replaceChild', (self, [, old]) => old);

  new MutationObserver((records) => {
    if (!parked.size) return;
    for (const r of records) {
      if (r.type === 'attributes') { restore(r.target); continue; }
      for (const n of r.addedNodes) {
        if (n.localName === 'iframe') restore(n);
        else if (n.getElementsByTagName) for (const f of [...n.getElementsByTagName('iframe')]) restore(f);
      }
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
}

module.exports = { keepEmbeds };
