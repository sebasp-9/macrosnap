# Simple_Calorie_Tracker
A simple calorie and protein tracker, you snap a photo of (or just talk to), and an AI fills in the numbers.

## Why I made this

I just wanted to track my calories and protein without the usual nonsense. Every "simple" calorie tracker I tried was one of three things: locked behind a monthly subscription, packed with ads, or just slow and bloated for what should be a basic task.

So I built my own. You bring your own (free) AI key, your data stays on your phone, there's no account, no ads, no subscription, and nothing tracking you. 

## What it does
-  Snap a photo of your meal **or pick one from your gallery** (forgot to open the app at dinner? add it later), or 🎙 just describe it (use your phone keyboard's mic to talk) - the AI estimates calories + protein per item, and you can tweak anything before saving
-  Daily calorie/protein goals with progress bars; browse previous days
-  Week / month / 3-month recap; anything older than 3 months is deleted automatically so the app never bloats
-  Works offline - log a meal with no signal and it analyzes itself once you're back online
-  100% on your device: your key and food log live only in your browser, nothing is sent anywhere except the AI provider you pick
-  Installs to your home screen like a real app (it's a PWA)

## 1. Get an AI key

**Only Google Gemini has a standing free tier** - that's the one to use. OpenAI and Claude are kept as options but are pay-as-you-go (no free tier).

| Provider | Free tier? | Where | Default model |
|---|---|---|---|
| **Google Gemini**  |  Yes — includes vision | https://aistudio.google.com/apikey | `gemini-2.5-flash` |
| OpenAI |  Pay-as-you-go | https://platform.openai.com/api-keys | `gpt-4o-mini` |
| Anthropic Claude |  Pay-as-you-go | https://console.anthropic.com | `claude-opus-4-8` (cheaper: `claude-haiku-4-5`) |

Open the app -> ⚙︎ Settings -> choose provider, paste key, set your goals → Save.

**Gemini free-tier notes:**
- It's limited by **rate** (roughly ~15 requests/min, a few hundred/day on flash models), not cost. Normal meal logging stays well under that; if you hit a limit the app says "wait a minute." Switch the model to `gemini-2.0-flash-lite` for higher limits.
- On the *free* tier, Google may use your inputs to improve its models (the paid tier doesn't). Food photos are low-sensitivity, but that's the free tradeoff.

## 2. Try it on your computer
No Node or Python needed — there's a tiny built-in server:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```
Then open **http://localhost:8000**.

## 3. Put it on your phone (free hosting via GitHub Pages)
iPhones need an HTTPS link to install a web app, and GitHub Pages gives you one for free:

1. Push this repo to GitHub (it's already set up for `sebasp-9/macrosnap`).
2. Repo → **Settings → Pages** → Source: `main` branch, `/ (root)` → Save.
3. After a minute it's live at **https://sebasp-9.github.io/macrosnap/**.
4. Open that URL in **Safari** → **Share** → **Add to Home Screen**.
5. Launch it from the icon — full-screen, just like a native app. Future pushes update it automatically.

> Any static HTTPS host works (Netlify, Cloudflare Pages, etc.) — it's just static files, no build step.

## Privacy
- **Your key** is stored only in this browser, never in the code, and never sent anywhere except the AI provider you chose. It's **encrypted at rest** with a non-extractable AES-GCM key (Web Crypto) and kept in IndexedDB — never as plaintext in localStorage. The app also uses a Content-Security-Policy that blocks it from talking to anything else. Treat the key like a password and lock your phone.
- **Your food log** stays on your device. Use **Export data** in Settings to back it up as JSON.
- **Photos are scrubbed before they leave your phone.** Camera or gallery, the image is re-encoded through a canvas, which keeps only the pixels: **no EXIF, so no GPS coordinates, no capture timestamp, no device serial, no embedded thumbnail.** It is also downscaled to 1024px, which keeps the upload (and the token cost) small. A gallery photo taken at home would otherwise carry your home's coordinates straight to the AI provider.
- **Choosing from the gallery does not give the app access to your gallery.** The picker is the operating system's own UI. The page never sees your library, only the single file you hand it, and no permission is granted or retained.
- **Meals queued while offline are encrypted** in IndexedDB with the same non-extractable key, since a queued meal can hold a photo and may sit on disk for days.
- **The saved key is never written back into the settings form.** It lives in memory and in encrypted storage, and nowhere else. Leave the field blank to keep it, type to replace it, or use **Remove saved key**.
- **Delete everything** in Settings wipes the log, counters, settings, the encrypted key and its wrapping key, and anything queued. It asks first, and it cannot be undone.
- **Nothing is kept forever.** Log entries, request counts and queued meals older than 3 months are deleted automatically on launch (`RETENTION_DAYS` in `app.js`). The recap covers that same window.
- **What gets sent:** only your (scrubbed) photo and/or text, only to your chosen provider, only when you tap Analyze. Nothing else.

## Files
```
index.html              the UI
styles.css              styling (dark, phone-friendly)
app.js                  logic: camera/gallery, voice, AI calls, storage, offline queue, retention
manifest.webmanifest    PWA manifest
sw.js                   service worker (offline support)
icons/                  app icons
serve.ps1               local server (no dependencies)
```

## Tweaking it
- **Models:** any vision-capable model from your provider works — just type its name in Settings.
- **How it estimates:** edit `SYSTEM_PROMPT` near the top of `app.js`.
- **How long data is kept:** change `RETENTION_DAYS` (default `90`) near the top of `app.js`.
- **Photo size sent to the AI:** `IMG_MAX_EDGE` / `IMG_QUALITY` in `app.js`.

## Note on the rename
The app is called **Simple_Calorie_Tracker**, but the GitHub repo is still `sebasp-9/macrosnap`, so the
Pages URL stays `https://sebasp-9.github.io/macrosnap/`. Renaming the repo would change that URL and
break the icon already on your home screen. The browser storage keys are likewise still `macrosnap.*`
on purpose: renaming them would orphan the food log already on your device.
