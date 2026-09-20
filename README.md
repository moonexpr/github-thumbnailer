# GitHub Thumbnailer

A Tampermonkey userscript that adds inline media thumbnails for files shown in GitHub directory listings.

## What it does

- Shows small image thumbnails next to file names in GitHub repo listings.
- Shows video thumbnails for supported media files.
- Adds inline audio players for audio files.
- Works on GitHub.com pages matching the script’s `@match` rule.

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

If you are hosting this script online, use the userscript URL in Tampermonkey and install it from there.

Example:

```text
https://your-domain.example/github-thumbnails.user.js
```

Then open the URL in your browser and choose the Tampermonkey install option.

## Script UUID

Reference UUID for this online script:

```text
cbc97abd-8a23-41a3-b930-8cbb4cef0a25
```

## Usage

After installation:

1. Visit a GitHub repository page or folder view.
2. Browse a directory listing with supported media files.
3. The script will render thumbnails inline without opening each file.

## Notes

- This script only runs on GitHub pages.
- You may need to refresh the page after installation.
- If the script does not appear, check that Tampermonkey is enabled for the site.

## Source

- Script: `github-thumbnails.user.js`
- Repository: `github-thumbnailer`
