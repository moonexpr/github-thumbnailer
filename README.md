# GitHub Thumbnailer

A Tampermonkey userscript that adds inline media thumbnails for files shown in GitHub directory listings.

## What it does

- Shows small image thumbnails next to file names in GitHub repo listings, with a larger preview on hover.
- Adds an inline player for audio files, loaded on demand when you press play.
- Resolves **Git LFS** files transparently, for both images and audio.
- Works on GitHub.com pages matching the script’s `@match` rule.

`.webm` is resolved by reading the file, not by its extension — see
[Ambiguous containers](#ambiguous-containers).

Video thumbnails are attempted but currently blocked — see [Content Security Policy](#content-security-policy).

## Install Tampermonkey

1. Install the Tampermonkey browser extension:
   - Chrome / Edge: https://www.tampermonkey.net/
   - Firefox: https://www.tampermonkey.net/
2. Once installed, open the extension dashboard.
3. Click the button to create or add a new userscript.

## Install this script

There are two common ways to install it:

### Option 1: Install from the local file in this repo

1. Open the repository folder and locate `github-thumbnails.user.js`.
2. Drag the file into your browser while Tampermonkey is active, or open it in a tab and use the Tampermonkey “Install this script” prompt.
3. Confirm the installation when prompted.

### Option 2: Install from the script URL

Open the script URL with Tampermonkey enabled and choose the “Install this script” prompt:

```text
https://github.com/moonexpr/github-thumbnailer/raw/refs/heads/main/github-thumbnails.user.js
```

[**Install github-thumbnails.user.js**](https://github.com/moonexpr/github-thumbnailer/raw/refs/heads/main/github-thumbnails.user.js)

## Usage

After installation:

1. Visit a GitHub repository page or folder view.
2. Browse a directory listing with supported media files.
3. The script will render thumbnails inline without opening each file.

## Content Security Policy

GitHub serves a strict CSP on every page, and it decides what this script can load.
The three directives that matter:

| Directive | Relevant entries | Consequence |
|---|---|---|
| `img-src` | `'self' data: blob: … *.githubusercontent.com` | Image thumbnails work directly. |
| `media-src` | `github.com`, `*-user-images.githubusercontent.com`, `gist.github.com`, … | No origin that serves repository files, and no `blob:`. |
| `connect-src` | `… raw.githubusercontent.com …` | `fetch()` to raw is permitted. |

`media-src` lists `github.com`, so the same-origin `github.com/<owner>/<repo>/raw/<ref>/<path>`
endpoint looks like a way in — but it is a 302 to `raw.githubusercontent.com`, and CSP
re-checks redirect targets. An `<audio src>` therefore cannot work here in any form.

A header-rewriting proxy (jsDelivr, statically.io, raw.githack.com) does not help: those
rewrite headers on the *media file's* response, while CSP is an origin allowlist on the
*page*, which no third party can add itself to.

**Audio** works around this entirely. `connect-src` allows `raw.githubusercontent.com`,
and raw responds with `access-control-allow-origin: *`, so the script fetches the bytes
and plays them through the Web Audio API — `decodeAudioData` takes an `ArrayBuffer` and
loads no URL, so no CSP directive applies. The cost is that `<audio controls>` is
unusable, hence the script's own small transport (play/pause, scrub, remaining time).

**Video** has no equivalent escape hatch. `media-src` allows neither raw nor `blob:`, so
a direct `src` and a `MediaSource` are both refused; real playback would mean WebCodecs
plus a demuxer. Video rows are therefore left with their ordinary file icon — the script
does not attach a `<video>` at all. An earlier version did, betting it would start
working if GitHub ever widened the directive, but the bet cost two CSP violations per
file in the console and a visible flash as the styled box painted and was then torn down.

## Ambiguous containers

`.webm` names a container, not a content type: the same extension covers a VP9 animation
and a Vorbis music track. GitHub is no help — it serves a VP9 file as
`Content-Type: audio/webm` — so neither the extension nor the response header can decide
which control belongs in the row.

The bytes can. Matroska writes its track CodecIDs as plain ASCII in the header, well
inside the first few KB, so the script range-reads 4 KB and looks for `V_VP8`, `V_VP9`, or
`V_AV1`. Found means video; otherwise audio. The result is cached per URL, and the row is
left untouched until the probe lands, so a listing never flashes the wrong control.

Cost is one small request per `.webm` in a listing — two when it is an LFS pointer, since
the prefix of the pointer is what comes back first. Every other extension is decided
statically and costs nothing.

## Git LFS

`raw.githubusercontent.com` serves a ~130-byte text pointer in place of an LFS file. The
real bytes are addressable directly, so the script never touches the LFS batch API:

```text
https://media.githubusercontent.com/media/<owner>/<repo>/<ref>/<path>
```

That host 404s for ordinary files, so it is only ever a second attempt, and CSP again
splits the two media types:

- **Images** — `img-src` lists `media.githubusercontent.com` outright, so an LFS image is
  one `src` swap away. The script does not probe first; it lets the first load fail (raw
  serves the pointer as `text/plain`, so the decode errors) and retries against the media
  host. Only LFS files pay, and only 131 bytes.
- **Audio** — `media.githubusercontent.com` is **absent from `connect-src`**, so `fetch`
  cannot reach it. The script uses `GM_xmlhttpRequest`, which runs in the userscript
  manager's context rather than the page's and is therefore subject to neither CSP nor
  CORS. This is why the script declares `@grant GM_xmlhttpRequest` and
  `@connect media.githubusercontent.com`; your manager will ask permission on install.

The privileged transport is used **only** for LFS audio. Ordinary files still go through
plain `fetch`, so a manager without `GM_xmlhttpRequest` keeps working for everything
except that one case.

## Notes

- This script only runs on GitHub pages.
- Audio previews only work for **public** repositories. Raw's `access-control-allow-origin: *`
  forbids credentialed reads, so private-repo files cannot be fetched from the page.
- You may need to refresh the page after installation.
- If the script does not appear, check that Tampermonkey is enabled for the site.

## Source

- Script: `github-thumbnails.user.js`
- Repository: `github-thumbnailer`
