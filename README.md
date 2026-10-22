# R7 Movie Wheel

A wheel that picks what to watch, plus a dashboard of what you have watched and a chat that can answer questions about your history.

- **Wheel.** Spin to pick from your to-watch list. Filter by one or more genres. Spin sounds (clicks and a landing chime) are made with Web Audio, with a mute button.
- **List.** Add movies with a dropdown of about 23,500 films (length, release year and genres fill in for you). Mark movies as watched, rate them 1 to 5 stars and add an optional short review. Filter watched movies by favorites, unrated and genre.
- **Dashboard.** Movies watched, hours watched, average rating, genres by count or by hours, rating spread, best-rated genres, favorites, release decades, longest and shortest watched, and the hours left on your watchlist.
- **Chat.** Ask questions about your list, ratings and reviews. It runs through a small Cloudflare Worker that holds your OpenAI key (setup below).
- **Sync.** The same Worker keeps your list on every device, so a phone and a laptop show the same list, ratings and reviews.

Styled with the R7 Orbit design system: obsidian, ivory and one brass accent.

## Run it

It is static files with no build step. Serve the folder (opening `index.html` straight from disk will not load the film library):

```
python -m http.server 8000
```

Then open <http://localhost:8000>. Your list is saved in your browser's local storage. To see the same list on every device, set up the Worker below; it keeps one copy of your list online and every device syncs to it. Fonts load from Google Fonts; without a connection the page falls back to system fonts.

## The film library

`movies-db.json` is built from [Wikidata](https://www.wikidata.org), whose data is CC0 (public domain). It is a snapshot (about 23,500 films with a known length, including many 2025 and 2026 releases). It does not update itself, and very new or obscure films may be missing. You can always type any title and set its length yourself with Edit.

## Set up the Worker (chat and list sync)

One Worker does two jobs. For **chat**: a page in the browser cannot hold an OpenAI key safely, because anyone who opens the page could read it, so the Worker keeps the key as a secret on Cloudflare; the page sends it your question and movie history, the Worker adds the key and calls OpenAI, and only the answer comes back. For **sync**: the Worker keeps one copy of your list in Cloudflare KV storage, and each device saves its changes to it and picks up changes from the others.

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and an [OpenAI API key](https://platform.openai.com/api-keys).

1. Sign in to Cloudflare from the Worker folder:

   ```
   cd worker
   npx wrangler login
   ```

2. Store your two secrets. Wrangler asks you to paste each value, so the key is never written in a file or typed into a command line:

   ```
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put APP_PASSPHRASE
   ```

   `OPENAI_API_KEY` is your OpenAI key. `APP_PASSPHRASE` is a password you make up; the chat page will ask for it.

3. Open `worker/wrangler.toml` and set `ALLOWED_ORIGINS` to the address where you open the app, such as `http://localhost:8000`. Add more addresses separated by commas, for example your GitHub Pages address (`https://your-name.github.io`). Change `OPENAI_MODEL` if you want a different model.

4. Deploy:

   ```
   npx wrangler deploy
   ```

   Wrangler prints the Worker's address, like `https://r7-movie-wheel-chat.your-name.workers.dev`. The first deploy also creates the `MOVIES` storage for your list. If Wrangler stops and asks for a KV namespace id instead, run `npx wrangler kv namespace create MOVIES`, then add the id it prints under `[[kv_namespaces]]` in `wrangler.toml` as `id = "..."` and deploy again.

5. Open the app, go to **Chat**, open **Connection settings**, and paste the Worker address and your passphrase. They are saved in your browser only. Do this once on each device. To avoid typing the address on each device, put it in `config.js` instead. As soon as both are entered, the list syncs: a line under the list says when it last synced, and shows a message if something is wrong (wrong passphrase, address not allowed, Worker unreachable).

### What the Worker checks

- Only the origins in `ALLOWED_ORIGINS` can call it.
- Every request needs your passphrase.
- At most 60 requests a minute per visitor (best effort). For a hard limit, uncomment the rate limiting block in `wrangler.toml`.
- Questions are capped in length and each answer is capped at 900 tokens, so a single question cannot run up a large bill.

### How sync works

- Each change is saved on the device straight away and sent to the Worker a moment later. Each device also checks for changes when you return to the tab and every minute.
- If two devices change the list while apart, the Worker merges them: each movie keeps its most recent edit, and a removed movie stays removed.
- If a device is offline, its changes wait and sync later.
- KV storage can take up to a minute to show a change in a different region, so a very recent change from another device may arrive a little late.
- **Export list** and **Import list** still work as a manual backup. Importing replaces the list everywhere.

### What is sent to OpenAI

With every question, the chat sends a text summary of your list: titles, years, lengths, genres, your star ratings and your reviews, for watched and to-watch movies. Nothing else leaves your browser.

### Running the Worker locally

```
cd worker
npx wrangler dev
```

Create `worker/.dev.vars` with `OPENAI_API_KEY=...` and `APP_PASSPHRASE=...` (that file is git-ignored), and use `http://localhost:8787` as the Worker address.

## Files

- `index.html` is the app (wheel, list, dashboard and the chat view).
- `chat.js` is the chat view, `sync.js` keeps the list in step across devices, `config.js` holds an optional default Worker address.
- `movies-db.json` is the film library.
- `worker/` is the Cloudflare Worker for the chat and list sync.
