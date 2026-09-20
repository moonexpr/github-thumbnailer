// ==UserScript==
// @name        GitHub Inline Media Thumbnails
// @version     1.3.0
// @description Render image thumbnails and inline audio players in GitHub directory (folder) listings, so you can preview media without clicking into each file.
// @license     MIT
// @author      you
// @namespace   https://github.com/moonexpr/github-thumbnailer
// @match       https://github.com/*
// @match       https://*.github.com/*
// @run-at      document-idle
// @grant       GM_xmlhttpRequest
// @connect     media.githubusercontent.com
// @icon        https://github.githubassets.com/favicons/favicon.png
// @updateURL   https://raw.githubusercontent.com/moonexpr/github-thumbnailer/main/github-thumbnails.user.js
// @downloadURL https://raw.githubusercontent.com/moonexpr/github-thumbnailer/main/github-thumbnails.user.js
// @supportURL  https://github.com/moonexpr/github-thumbnailer/issues
// ==/UserScript==

(function () {
  'use strict';

  /* ============================ configuration ============================ */

  const CONFIG = Object.freeze({
    thumbWidth: 44,     // px, fixed thumbnail box
    thumbHeight: 32,
    previewMax: 480,    // px, max dimension of the hover preview
    audioWidth: 240,    // px, width of the inline transport
    rescanDelay: 150,   // ms, debounce for SPA / React churn
  });

  // Attributes we own. Everything this script adds to GitHub's DOM is tagged,
  // so a rescan can tell its own work from React's.
  const ATTR = Object.freeze({
    thumb: 'data-ght-thumb',       // an injected image/video thumbnail
    audio: 'data-ght-audio',       // an injected audio transport
    hide: 'data-ght-hide',         // an original file icon, hidden by our stylesheet
    failed: 'data-ght-failed',     // a row we gave up on; later scans leave it alone
  });

  const GLYPH = Object.freeze({
    play: '▶', pause: '⏸', loading: '···', failed: '⚠',
  });

  const COLUMN_SELECTOR = [
    '.react-directory-filename-column',
    '[class*="filename-column"]',
    '[class*="name-cell"]',
    'td',
    '[role="gridcell"]',
    'li',
    '[role="treeitem"]',
  ].join(', ');

  const STYLE = Object.freeze({
    overlay: {
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
    },
    overlayMedia: {
      maxWidth: CONFIG.previewMax + 'px',
      maxHeight: CONFIG.previewMax + 'px',
      display: 'block',
    },
    thumb: {
      width: CONFIG.thumbWidth + 'px',
      height: CONFIG.thumbHeight + 'px',
      objectFit: 'contain',          // letterbox into the fixed box, never crop
      verticalAlign: 'middle',
      marginRight: '8px',
      borderRadius: '4px',
      boxSizing: 'border-box',
      // theme-respecting border: GitHub supplies the right value per theme
      border: '1px solid var(--fgColor-link)',
      boxShadow: '0 1px 2px var(--shadow-resting-small, rgba(31,35,40,0.06))',
      // checkerboard shows through wherever the image doesn't fill the box
      backgroundColor: 'var(--bgColor-default, var(--color-canvas-default, #fff))',
      backgroundImage: 'repeating-conic-gradient(#8080803a 0% 25%, transparent 0% 50%)',
      backgroundPosition: '50%',
      backgroundSize: '10px 10px',
    },
    transport: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      width: CONFIG.audioWidth + 'px',
      height: (CONFIG.thumbHeight - 4) + 'px',
      padding: '0 8px',
      marginRight: '8px',
      verticalAlign: 'middle',
      boxSizing: 'border-box',
      border: '1px solid var(--borderColor-default, #d0d7de)',
      borderRadius: '999px',
      background: 'var(--bgColor-muted, var(--color-canvas-subtle, #f6f8fa))',
      font: '11px var(--fontStack-monospace, ui-monospace, monospace)',
      color: 'var(--fgColor-muted, #59636e)',
    },
    transportButton: {
      all: 'unset',                  // must stay first; the rest override it
      cursor: 'pointer',
      flex: '0 0 auto',
      width: '12px',
      textAlign: 'center',
      lineHeight: '1',
      color: 'var(--fgColor-accent, #0969da)',
    },
    transportTrack: {
      flex: '1 1 auto',
      position: 'relative',
      height: '4px',
      borderRadius: '2px',
      cursor: 'pointer',
      background: 'var(--borderColor-default, #d0d7de)',
    },
    transportFill: {
      position: 'absolute', left: '0', top: '0', bottom: '0', width: '0%',
      borderRadius: '2px', background: 'var(--fgColor-accent, #0969da)',
    },
    transportTime: {
      flex: '0 0 auto', fontVariantNumeric: 'tabular-nums',
    },
    transportFailed: {
      color: 'var(--fgColor-danger, #cf222e)', cursor: 'default',
    },
  });

  /* =============================== helpers =============================== */

  function el(tag, style = {}, props = {}) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    Object.assign(node.style, style);
    return node;
  }

  function formatTime(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
  }

  /* ============================ media reference ========================== */

  /**
   * A media file found in a directory listing.
   *
   * `MediaRef.from` is the only boundary where a raw <a> becomes trusted data.
   * Past it every field is known good, so nothing downstream re-validates.
   */
  class MediaRef {
    // `probe` is for extensions that name a container rather than a content
    // type: a .webm is as likely to be a VP9 animation as a Vorbis music
    // track, and the extension cannot say which. Those are resolved by
    // reading the file header -- see ContainerProbe.
    static #PATTERNS = Object.freeze({
      img: /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i,
      vid: /\.(mp4|ogv|m4v|mov)$/i,
      aud: /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i,
      probe: /\.webm$/i,
    });

    /** @returns {MediaRef|null} null when `anchor` is not a media filename link. */
    static from(anchor) {
      const href = anchor.getAttribute('href') || '';
      if (!href.includes('/blob/')) return null;

      const kind = Object.keys(MediaRef.#PATTERNS).find((k) => MediaRef.#PATTERNS[k].test(href));
      if (!kind) return null;

      // Only a directory-listing filename link: its text is the bare basename.
      // This rejects breadcrumbs, commit links, and prose references to a file.
      const name = MediaRef.#basename(href);
      if ((anchor.textContent || '').trim() !== name) return null;

      return new MediaRef(kind, href, name);
    }

    static #basename(href) {
      const clean = href.split('?')[0].split('#')[0];
      const segment = clean.slice(clean.lastIndexOf('/') + 1);
      try { return decodeURIComponent(segment); } catch { return segment; }
    }

    // `/<owner>/<repo>/blob/<ref>/<path>` minus the `/blob` segment is the tail
    // both content hosts want, so one slice serves each.
    static #tail(href) {
      const { pathname } = new URL(href, location.origin);
      const cut = pathname.indexOf('/blob/');
      return pathname.slice(0, cut) + '/' + pathname.slice(cut + '/blob/'.length);
    }

    constructor(kind, href, name) {
      const tail = MediaRef.#tail(href);
      this.kind = kind;
      this.name = name;

      // Point straight at raw.githubusercontent.com rather than GitHub's
      // same-origin /raw/<ref>/<path> endpoint: the latter is a 302 to raw,
      // and CSP re-checks redirect targets, so the same-origin form buys
      // nothing and only costs a round trip. The tail already carries the
      // exact ref, so nothing has to guess a default branch.
      this.url = 'https://raw.githubusercontent.com' + tail;

      // Where the real bytes live when the file is a Git LFS pointer. This
      // host 404s for ordinary files, so it is only ever a second attempt.
      this.lfsUrl = 'https://media.githubusercontent.com/media' + tail;

      Object.freeze(this);
    }
  }

  /* ============================ preview overlay ========================== */

  /** The hover card, shared by every thumbnail on the page. */
  class PreviewOverlay {
    static #instance = null;
    static get instance() {
      return (PreviewOverlay.#instance ??= new PreviewOverlay());
    }

    #box = el('div', STYLE.overlay);

    show(node, x, y) {
      if (!this.#box.isConnected) document.body.appendChild(this.#box);
      this.#box.replaceChildren(node);   // clearing also stops a playing video
      this.#box.style.display = 'block';
      this.move(x, y);
    }

    move(x, y) {
      const pad = 16;
      const max = CONFIG.previewMax;
      let left = x + pad;
      let top = y + pad;
      if (left + max > window.innerWidth) left = x - max - pad;
      if (top + max > window.innerHeight) top = Math.max(pad, window.innerHeight - max - pad);
      this.#box.style.left = Math.max(pad, left) + 'px';
      this.#box.style.top = top + 'px';
    }

    hide() {
      this.#box.style.display = 'none';
      this.#box.replaceChildren();
    }
  }

  /* =============================== git lfs ============================== */

  /**
   * A Git LFS pointer -- the ~130-byte text stub that raw.githubusercontent.com
   * serves in place of the real file:
   *
   *     version https://git-lfs.github.com/spec/v1
   *     oid sha256:<64 hex>
   *     size <bytes>
   *
   * We only need to recognise it, not parse it: the real bytes are addressable
   * at `media.githubusercontent.com/media/<owner>/<repo>/<ref>/<path>`, so the
   * LFS batch API and its oid never come into it.
   */
  const LFS_MAGIC = 'version https://git-lfs.github.com/spec/v1';

  function isLfsPointer(bytes) {
    if (bytes.byteLength > 1024) return false;   // a pointer is never this big
    const head = new Uint8Array(bytes, 0, Math.min(LFS_MAGIC.length, bytes.byteLength));
    return new TextDecoder().decode(head) === LFS_MAGIC;
  }

  /**
   * Byte retrieval, with two transports because CSP splits them:
   *
   * - `fetch` reaches raw.githubusercontent.com, which `connect-src` allows.
   * - `media.githubusercontent.com` is in `img-src` but *not* `connect-src`,
   *   so `fetch` cannot touch it. GM_xmlhttpRequest runs in the extension's
   *   context rather than the page's, so neither CSP nor CORS applies to it.
   *
   * Only the LFS path needs the privileged transport, so a manager without
   * GM_xmlhttpRequest still previews ordinary files.
   */
  class Transfer {
    static get privileged() { return typeof GM_xmlhttpRequest === 'function'; }

    /** Plain fetch: subject to `connect-src`. */
    static bytes(url, headers) {
      // Credentials are omitted deliberately: raw's ACAO is `*`, which forbids
      // credentialed reads, so private repos cannot be previewed.
      return fetch(url, { credentials: 'omit', headers }).then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.arrayBuffer();
      });
    }

    /** Extension-context request: exempt from `connect-src` and from CORS. */
    static privilegedBytes(url, headers) {
      if (!Transfer.privileged) {
        throw new Error('stored in Git LFS, which needs GM_xmlhttpRequest');
      }
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          headers,
          responseType: 'arraybuffer',
          onload: (r) => (r.status >= 200 && r.status < 300
            ? resolve(r.response)
            : reject(new Error('HTTP ' + r.status))),
          onerror: () => reject(new Error('request failed')),
          ontimeout: () => reject(new Error('request timed out')),
        });
      });
    }

    /**
     * Bytes for `ref`, transparently following a Git LFS pointer. `length`
     * limits the read to a prefix; omit it for the whole file. Both hosts
     * honour Range, and a pointer shorter than the window simply comes back
     * whole.
     */
    static resolve(ref, length) {
      const headers = length ? { Range: 'bytes=0-' + (length - 1) } : undefined;
      return Transfer.bytes(ref.url, headers)
        .then((bytes) => (isLfsPointer(bytes)
          ? Transfer.privilegedBytes(ref.lfsUrl, headers)
          : bytes));
    }
  }

  /**
   * Settles what an ambiguous container actually holds.
   *
   * `.webm` names a container, not a content type, and GitHub is no help: it
   * serves a VP9 animation as `Content-Type: audio/webm`. The bytes are
   * decisive, though. Matroska writes its track CodecIDs as plain ASCII in the
   * header -- `V_VP8`/`V_VP9`/`V_AV1` for a video track -- and they land well
   * inside the first few KB, so one short range read is enough.
   */
  class ContainerProbe {
    static #WINDOW = 4096;
    static #VIDEO_CODECS = ['V_VP8', 'V_VP9', 'V_AV1'];
    static #cache = new Map();   // url -> Promise<'aud'|'vid'>

    /** @returns {Promise<'aud'|'vid'>} */
    static kind(ref) {
      let pending = ContainerProbe.#cache.get(ref.url);
      if (!pending) {
        pending = Transfer.resolve(ref, ContainerProbe.#WINDOW)
          .then((bytes) => (ContainerProbe.#hasVideoTrack(bytes) ? 'vid' : 'aud'))
          .catch((error) => {
            // Don't cache a failure: let a later scan try again.
            ContainerProbe.#cache.delete(ref.url);
            throw error;
          });
        ContainerProbe.#cache.set(ref.url, pending);
      }
      return pending;
    }

    // latin1 maps bytes one-to-one onto code points, so an ASCII search over
    // binary is exact and needs no framing.
    static #hasVideoTrack(bytes) {
      const header = new TextDecoder('latin1').decode(bytes);
      return ContainerProbe.#VIDEO_CODECS.some((codec) => header.includes(codec));
    }
  }

  /* ================================ audio ================================ */

  /**
   * Owns the single AudioContext, the decoded-buffer cache, and the rule that
   * only one clip plays at a time.
   *
   * A plain <audio src> can never work on github.com. The page CSP lists no
   * usable origin in `media-src` for repository files: the same-origin /raw/
   * endpoint 302s to raw.githubusercontent.com, which is not in the list, and
   * CSP re-checks redirect targets. Proxies don't help either -- they rewrite
   * the *file's* headers, while CSP is an origin allowlist on the *page*,
   * which no third party can add itself to.
   *
   * `connect-src` does allow raw.githubusercontent.com, and raw serves
   * `access-control-allow-origin: *`, so we fetch the bytes ourselves and play
   * them through the Web Audio API: decodeAudioData takes an ArrayBuffer and
   * loads no URL, so no CSP directive applies to it.
   */
  class AudioEngine {
    static #instance = null;
    static get instance() {
      return (AudioEngine.#instance ??= new AudioEngine());
    }

    #context = null;
    #buffers = new Map();   // url -> Promise<AudioBuffer>
    #holder = null;

    get context() {
      return (this.#context ??= new AudioContext());
    }

    /** Decoded audio for `ref`, fetched and decoded at most once per page. */
    load(ref) {
      let pending = this.#buffers.get(ref.url);
      if (!pending) {
        pending = Transfer.resolve(ref).then((bytes) => this.context.decodeAudioData(bytes));
        this.#buffers.set(ref.url, pending);
      }
      return pending;
    }

    /** Hand the output to `transport`, pausing whoever held it. */
    claim(transport) {
      if (this.#holder && this.#holder !== transport) this.#holder.pause();
      this.#holder = transport;
    }

    release(transport) {
      if (this.#holder === transport) this.#holder = null;
    }
  }

  /**
   * The inline widget that stands in for <audio controls>, which CSP denies us:
   * play/pause, click-to-scrub, remaining time. Audio is fetched lazily, on the
   * first press of play.
   */
  class AudioTransport {
    static attach(row, ref) {
      row.addBeside(new AudioTransport(ref).element, ATTR.audio);
    }

    #ref;
    #buffer = null;
    #source = null;
    #startedAt = 0;
    #offset = 0;
    #playing = false;

    #root = el('span', STYLE.transport);
    #button = el('button', STYLE.transportButton, { type: 'button', textContent: GLYPH.play });
    #track = el('span', STYLE.transportTrack);
    #fill = el('span', STYLE.transportFill);
    #time = el('span', STYLE.transportTime, { textContent: '--:--' });

    constructor(ref) {
      this.#ref = ref;
      this.#button.title = 'Play ' + ref.name;
      this.#track.appendChild(this.#fill);
      this.#root.append(this.#button, this.#track, this.#time);
      this.#button.addEventListener('click', (event) => this.#onPress(event));
      this.#track.addEventListener('click', (event) => this.#onScrub(event));
    }

    get element() { return this.#root; }

    get #elapsed() {
      if (!this.#buffer) return 0;
      const live = AudioEngine.instance.context.currentTime - this.#startedAt;
      const at = this.#playing ? this.#offset + live : this.#offset;
      return Math.min(this.#buffer.duration, Math.max(0, at));
    }

    play() {
      const engine = AudioEngine.instance;
      engine.claim(this);
      if (this.#offset >= this.#buffer.duration - 0.01) this.#offset = 0;

      const source = engine.context.createBufferSource();
      source.buffer = this.#buffer;
      source.connect(engine.context.destination);
      source.onended = () => { if (this.#source === source) this.#halt(0); };

      this.#source = source;
      this.#startedAt = engine.context.currentTime;
      this.#playing = true;
      source.start(0, this.#offset);
      this.#button.textContent = GLYPH.pause;
      this.#render();
    }

    pause() { this.#halt(this.#elapsed); }

    /** Stop the source node and park the playhead at `offset`. */
    #halt(offset) {
      if (this.#source) {
        this.#source.onended = null;
        this.#source.stop();
        this.#source = null;
      }
      this.#playing = false;
      this.#offset = offset;
      this.#button.textContent = GLYPH.play;
      AudioEngine.instance.release(this);
      this.#render();
    }

    #render() {
      // React can discard the row from under us; an AudioBufferSourceNode is
      // not DOM-bound, so it would otherwise play on with no UI attached.
      if (this.#playing && !this.#root.isConnected) { this.#halt(0); return; }

      const duration = this.#buffer ? this.#buffer.duration : 0;
      const at = this.#elapsed;
      this.#fill.style.width = duration ? (at / duration) * 100 + '%' : '0%';
      this.#time.textContent = duration ? formatTime(duration - at) : '--:--';
      if (this.#playing) requestAnimationFrame(() => this.#render());
    }

    #onPress(event) {
      event.preventDefault();
      event.stopPropagation();
      if (this.#playing) return this.pause();
      if (this.#buffer) return this.play();

      this.#button.textContent = GLYPH.loading;
      AudioEngine.instance.context.resume();
      AudioEngine.instance.load(this.#ref)
        .then((buffer) => { this.#buffer = buffer; this.play(); })
        .catch((error) => this.#fail(error));
    }

    #onScrub(event) {
      event.preventDefault();
      event.stopPropagation();
      if (!this.#buffer) return;

      const box = this.#track.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      const resume = this.#playing;
      this.#halt(fraction * this.#buffer.duration);
      if (resume) this.play();
    }

    #fail(error) {
      Object.assign(this.#button.style, STYLE.transportFailed);
      this.#button.textContent = GLYPH.failed;
      this.#button.disabled = true;
      this.#button.title = 'Could not play ' + this.#ref.name + ': ' + error.message;
      this.#time.textContent = '';
    }
  }

  /* ============================== thumbnails ============================= */

  /**
   * The image thumbnail that takes over a row's file-icon slot, and its hover
   * preview.
   *
   * Images need no privileged transport: `img-src` lists
   * media.githubusercontent.com outright, so an LFS file is one `src` swap
   * away. Rather than probe first -- which would cost every ordinary image a
   * request -- we let the browser tell us: raw serves a pointer as
   * `text/plain`, so the decode fails and `error` fires. Only LFS files pay,
   * and only 131 bytes.
   */
  class ImageThumbnail {
    static attach(row, ref) {
      if (row.failed) return;
      row.replaceIcon(new ImageThumbnail(ref, row).element, ATTR.thumb);
    }

    #img;

    constructor(ref, row) {
      this.#img = el('img', STYLE.thumb,
        { src: ref.url, loading: 'lazy', decoding: 'async', alt: '' });

      let retried = false;
      this.#img.addEventListener('error', () => {
        if (retried) return row.giveUp(this.#img);
        retried = true;
        this.#img.src = ref.lfsUrl;   // a pointer, apparently: try the real bytes
      });

      // The preview reads `#img.src`, not `ref.url`, so one opened after the
      // LFS retry shows the file rather than re-fetching the pointer.
      const overlay = PreviewOverlay.instance;
      this.#img.addEventListener('mouseenter', (e) => overlay.show(
        el('img', STYLE.overlayMedia, { src: this.#img.src, alt: ref.name }),
        e.clientX, e.clientY));
      this.#img.addEventListener('mousemove', (e) => overlay.move(e.clientX, e.clientY));
      this.#img.addEventListener('mouseleave', () => overlay.hide());
    }

    get element() { return this.#img; }
  }

  /**
   * Video renders nothing, deliberately.
   *
   * `media-src` allows neither raw.githubusercontent.com nor `blob:`, so a
   * direct `src` and a MediaSource are both refused, and the Web Audio escape
   * hatch has no video equivalent short of WebCodecs plus a demuxer.
   *
   * An earlier version attached the <video> anyway, reasoning that it would
   * start working the day GitHub widened the directive. The cost of that bet
   * was paid every page load and the payoff may never arrive: two CSP
   * violations per file in the console, and a visible flash in the listing as
   * the styled box paints and the error handler then tears it down. The row
   * keeps its ordinary file icon instead.
   */
  class BlockedVideo {
    static attach() { /* nothing can render here yet */ }
  }

  /**
   * Not a widget itself: it probes the container and hands the row to the one
   * that fits. Until the probe lands the row is left alone, so a listing never
   * flashes the wrong control. Re-running is free -- the probe is cached by URL
   * and the real widget does its own idempotency check -- so a row that React
   * wipes is repaired by the next scan without a second request.
   */
  class AmbiguousContainer {
    static attach(row, ref) {
      ContainerProbe.kind(ref).then(
        (kind) => WIDGETS[kind].attach(row, ref),
        () => { /* probe failed; a later scan retries */ },
      );
    }
  }

  const WIDGETS = Object.freeze({
    img: ImageThumbnail,
    vid: BlockedVideo,
    aud: AudioTransport,
    probe: AmbiguousContainer,
  });

  /* ============================= listing rows ============================ */

  /**
   * One filename cell in a directory listing.
   *
   * GitHub's React owns this DOM and re-renders it freely -- notably when the
   * lazy commit cells load -- so every mutation here is idempotent and gets
   * re-applied on the next scan rather than being done once. In particular the
   * original <svg> icon is hidden by attribute, never removed: React would just
   * put it back.
   */
  class DirectoryRow {
    static forAnchor(anchor) {
      const column = anchor.closest(COLUMN_SELECTOR);
      return column ? new DirectoryRow(anchor, column) : null;
    }

    #anchor;
    #column;

    constructor(anchor, column) {
      this.#anchor = anchor;
      this.#column = column;
    }

    get failed() { return this.#column.hasAttribute(ATTR.failed); }

    /**
     * Give up on this row: drop the thumbnail and hand the file icon back.
     * Without the mark, the next scan would see an empty icon slot, build
     * another thumbnail, and fail again on every pass.
     */
    giveUp(node) {
      node.remove();
      this.#column.setAttribute(ATTR.failed, '1');
      this.#column.querySelectorAll('[' + ATTR.hide + ']')
        .forEach((icon) => icon.removeAttribute(ATTR.hide));
    }

    /** Thumbnails take over the file-icon slot. */
    replaceIcon(node, attr) {
      if (!this.#column.querySelector(':scope > [' + attr + ']')) {
        node.setAttribute(attr, '1');
        this.#column.insertBefore(node, this.#column.firstChild);
      }
      // Re-tag every pass so a React-recreated icon gets re-hidden. Only the
      // plain file glyph: folder icons (octicon-file-directory*) are left alone.
      this.#column.querySelectorAll('svg.octicon-file:not([' + ATTR.hide + '])')
        .forEach((icon) => icon.setAttribute(ATTR.hide, '1'));
    }

    /** Audio keeps its file icon; the transport sits just before the name. */
    addBeside(node, attr) {
      const host = this.#anchor.parentNode;
      if (host.querySelector(':scope > [' + attr + ']')) return;
      node.setAttribute(attr, '1');
      host.insertBefore(node, this.#anchor);
    }
  }

  /* ============================== orchestrator =========================== */

  /**
   * Finds media links and keeps their decorations attached across Turbo
   * navigation and React re-renders.
   */
  class Thumbnailer {
    #style = el('style', {}, { textContent: '[' + ATTR.hide + ']{display:none !important}' });
    #timer = null;

    start() {
      this.scan();
      new MutationObserver(() => this.#schedule()).observe(document.documentElement, {
        childList: true, subtree: true,
      });
      document.addEventListener('turbo:load', () => this.#schedule());
      document.addEventListener('pjax:end', () => this.#schedule());
    }

    scan() {
      if (!this.#style.isConnected) (document.head || document.documentElement).appendChild(this.#style);
      document.querySelectorAll('a[href*="/blob/"]').forEach((anchor) => this.#decorate(anchor));
    }

    #decorate(anchor) {
      const ref = MediaRef.from(anchor);
      if (!ref) return;
      const row = DirectoryRow.forAnchor(anchor);
      if (row) WIDGETS[ref.kind].attach(row, ref);
    }

    #schedule() {
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.scan(), CONFIG.rescanDelay);
    }
  }

  new Thumbnailer().start();
})();
