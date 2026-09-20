// ==UserScript==
// @name        GitHub Inline Media Thumbnails
// @version     1.2.0
// @description Render image/video thumbnails and inline audio players in GitHub directory (folder) listings, so you can preview media without clicking into each file.
// @license     MIT
// @author      you
// @namespace   https://github.com/moonexpr/github-thumbnailer
// @match       https://github.com/*
// @match       https://*.github.com/*
// @run-at      document-idle
// @grant       none
// @icon        https://github.githubassets.com/favicons/favicon.png
// @updateURL   https://raw.githubusercontent.com/moonexpr/github-thumbnailer/main/github-thumbnails.user.js
// @downloadURL https://raw.githubusercontent.com/moonexpr/github-thumbnailer/main/github-thumbnails.user.js
// @supportURL  https://github.com/moonexpr/github-thumbnailer/issues
// ==/UserScript==

(function () {
  'use strict';

  /* ----------------------------- config ----------------------------- */
  const THUMB_W = 44; // px, fixed thumbnail box width  (images + video)
  const THUMB_H = 32; // px, fixed thumbnail box height (images + video)
  const PREVIEW_MAX = 480; // px, max dimension of the hover preview
  const AUDIO_WIDTH = 240; // px, width of the inline audio player

  const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;
  const VID_EXT = /\.(mp4|webm|ogv|m4v|mov)$/i;
  const AUD_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i;

  /* ------------- lazy-load observer for video thumbnails ------------ */
  // <video> doesn't honor loading="lazy", so only fetch metadata once a
  // thumbnail scrolls near the viewport.
  const videoIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const v = e.target;
      if (!v.dataset.loaded) {
        v.preload = 'metadata';
        v.src = v.dataset.src;
        v.load();
        v.dataset.loaded = '1';
      }
      videoIO.unobserve(v);
    }
  }, { rootMargin: '200px' });

  /* --------------------- shared hover preview box ------------------- */
  let pbox = null;
  function ensureBox() {
    if (pbox) return pbox;
    pbox = document.createElement('div');
    Object.assign(pbox.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '99999',
      border: '1px solid var(--borderColor-default, #d0d7de)',
      borderRadius: '6px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
      background: 'var(--bgColor-default, #fff)',
      padding: '4px',
      display: 'none',
      lineHeight: '0',
    });
    document.body.appendChild(pbox);
    return pbox;
  }
  function showPreview(node, x, y) {
    const b = ensureBox();
    b.replaceChildren(node);   // clearing also stops any playing video
    b.style.display = 'block';
    movePreview(x, y);
  }
  function movePreview(x, y) {
    if (!pbox) return;
    const pad = 16;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = x + pad, top = y + pad;
    if (left + PREVIEW_MAX > vw) left = x - PREVIEW_MAX - pad;
    if (top + PREVIEW_MAX > vh) top = Math.max(pad, vh - PREVIEW_MAX - pad);
    pbox.style.left = Math.max(pad, left) + 'px';
    pbox.style.top = top + 'px';
  }
  function hidePreview() {
    if (pbox) { pbox.style.display = 'none'; pbox.replaceChildren(); }
  }
  function previewImage(src) {
    const i = document.createElement('img');
    i.src = src;
    Object.assign(i.style, { maxWidth: PREVIEW_MAX + 'px', maxHeight: PREVIEW_MAX + 'px', display: 'block' });
    return i;
  }
  function previewVideo(src) {
    const v = document.createElement('video');
    v.src = src;
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    Object.assign(v.style, { maxWidth: PREVIEW_MAX + 'px', maxHeight: PREVIEW_MAX + 'px', display: 'block' });
    return v;
  }

  /* ------------------------- url helpers ---------------------------- */
  // github.com/{owner}/{repo}/raw/{ref}/{path} is a same-origin redirect to
  // the raw CDN. Private repos work via your session cookie, and we never
  // have to parse the ref.
  function rawUrl(blobPath) {
    return 'https://github.com' + blobPath.replace('/blob/', '/raw/');
  }
  function basename(path) {
    const clean = path.split('?')[0].split('#')[0];
    const seg = clean.substring(clean.lastIndexOf('/') + 1);
    try { return decodeURIComponent(seg); } catch { return seg; }
  }

  const baseThumbStyle = {
    width: THUMB_W + 'px',
    height: THUMB_H + 'px',
    objectFit: 'contain',          // letterbox/pillarbox into the fixed box, no cropping
    verticalAlign: 'middle',
    marginRight: '8px',
    borderRadius: '4px',
    boxSizing: 'border-box',
    // theme-respecting border: prefer the current Primer token, then the older
    // token name, then a light-mode hex; GitHub supplies the right value per theme
    border: '1px solid var(--fgColor-link)',
    boxShadow: '0 1px 2px var(--shadow-resting-small, rgba(31,35,40,0.06))',
    // checkerboard shows through wherever the image doesn't fill the box
    backgroundColor: 'var(--bgColor-default, var(--color-canvas-default, #fff))',
    backgroundImage: 'repeating-conic-gradient(#8080803a 0% 25%, transparent 0% 50%)',
    backgroundPosition: '50%',
    backgroundSize: '10px 10px',
  };

  /* --------------------------- builders ----------------------------- */
  function makeImageThumb(src) {
    const img = document.createElement('img');
    img.src = src;
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
    Object.assign(img.style, baseThumbStyle);
    img.addEventListener('error', () => img.remove(), { once: true });
    img.addEventListener('mouseenter', (e) => showPreview(previewImage(src), e.clientX, e.clientY));
    img.addEventListener('mousemove', (e) => movePreview(e.clientX, e.clientY));
    img.addEventListener('mouseleave', hidePreview);
    return img;
  }

  function makeVideoThumb(src) {
    const v = document.createElement('video');
    v.dataset.src = src;          // real src set lazily by videoIO
    v.muted = true; v.playsInline = true; v.preload = 'none';
    Object.assign(v.style, { ...baseThumbStyle, cursor: 'pointer' });
    // nudge to a real frame once data is available
    v.addEventListener('loadeddata', () => { try { v.currentTime = 0.1; } catch (_) {} }, { once: true });
    v.addEventListener('error', () => v.remove(), { once: true });
    v.addEventListener('mouseenter', (e) => showPreview(previewVideo(src), e.clientX, e.clientY));
    v.addEventListener('mousemove', (e) => movePreview(e.clientX, e.clientY));
    v.addEventListener('mouseleave', hidePreview);
    videoIO.observe(v);
    return v;
  }

  function makeAudioPlayer(src) {
    const a = document.createElement('audio');
    a.controls = true; a.preload = 'none'; a.src = src;
    Object.assign(a.style, {
      height: (THUMB_H - 4) + 'px',
      width: AUDIO_WIDTH + 'px',
      maxWidth: AUDIO_WIDTH + 'px',
      verticalAlign: 'middle',
      marginRight: '8px',
    });
    a.addEventListener('error', () => a.remove(), { once: true });
    return a;
  }

  /* --------------------------- core --------------------------------- */
  // We do NOT remove GitHub's <svg> file icon (React owns it and restores it
  // whenever the row re-renders, e.g. when the lazy commit cells load). Instead
  // we tag this row's icon with an attribute and hide it via a global rule,
  // re-tagging on every scan so a React-recreated icon gets re-hidden. The
  // thumbnail is also re-added if React ever discards it.

  const THUMB_ATTR = 'data-ght-thumb';   // marks an injected image/video thumb
  const AUDIO_ATTR = 'data-ght-audio';   // marks an injected audio player
  const HIDE_ATTR  = 'data-ght-hide';    // marks the original file icon to hide

  function injectStyleOnce() {
    if (document.getElementById('ght-style')) return;
    const s = document.createElement('style');
    s.id = 'ght-style';
    s.textContent = '[' + HIDE_ATTR + ']{display:none !important}';
    (document.head || document.documentElement).appendChild(s);
  }

  function columnFor(anchor) {
    return anchor.closest(
      '.react-directory-filename-column, [class*="filename-column"], ' +
      '[class*="name-cell"], td, [role="gridcell"], li, [role="treeitem"]'
    );
  }

  function processAnchor(a) {
    const href = a.getAttribute('href') || '';
    if (!href.includes('/blob/')) return;

    let kind = null;
    if (IMG_EXT.test(href)) kind = 'img';
    else if (VID_EXT.test(href)) kind = 'vid';
    else if (AUD_EXT.test(href)) kind = 'aud';
    else return;

    // Only a directory-listing filename link: visible text === file basename.
    const text = (a.textContent || '').trim();
    if (!text || text !== basename(href)) return;

    const src = rawUrl(href);

    if (kind === 'aud') {
      // audio keeps the file icon; just add the player next to the name
      const host = a.parentNode;
      if (!host || host.querySelector(':scope > [' + AUDIO_ATTR + ']')) return;
      const node = makeAudioPlayer(src);
      node.setAttribute(AUDIO_ATTR, '1');
      host.insertBefore(node, a);
      return;
    }

    // image / video: thumbnail takes the icon's slot, original icon hidden
    const col = columnFor(a);
    if (!col) return;

    // (1) ensure the thumbnail is present (re-add if React wiped it)
    if (!col.querySelector(':scope > [' + THUMB_ATTR + ']')) {
      const node = (kind === 'img' ? makeImageThumb : makeVideoThumb)(src);
      node.setAttribute(THUMB_ATTR, '1');
      col.insertBefore(node, col.firstChild);
    }

    // (2) hide this row's file icon — re-tag every pass so a React-recreated
    //     icon gets re-hidden. octicon-file is the plain file glyph; we leave
    //     folder icons (octicon-file-directory*) alone.
    col.querySelectorAll('svg.octicon-file:not([' + HIDE_ATTR + '])')
       .forEach((ic) => ic.setAttribute(HIDE_ATTR, '1'));
  }

  function scan() {
    injectStyleOnce();
    document.querySelectorAll('a[href*="/blob/"]').forEach(processAnchor);
  }

  /* ----------- debounced rescans for SPA / Turbo navigation --------- */
  let timer = null;
  function schedule() { clearTimeout(timer); timer = setTimeout(scan, 150); }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true,
  });

  scan();
  document.addEventListener('turbo:load', schedule);
  document.addEventListener('pjax:end', schedule);
})();