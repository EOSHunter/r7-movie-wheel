# R7 Movie Wheel

A wheel that picks what to watch, plus a dashboard of what you have watched and a chat that can answer questions about your history.

- **Wheel.** Spin to pick from your to-watch list. Filter by one or more genres. Spin sounds (clicks and a landing chime) are made with Web Audio, with a mute button.
- **List.** Add movies with a dropdown of about 23,500 films (length, release year and genres fill in for you). Mark movies as watched, rate them 1 to 5 stars and add an optional short review. Filter watched movies by favorites, unrated and genre.
- **Dashboard.** Movies watched, hours watched, average rating, genres by count or by hours, rating spread, best-rated genres, favorites, release decades, longest and shortest watched, and the hours left on your watchlist.
- **Chat.** Ask questions about your list, ratings and reviews. It runs through a small Cloudflare Worker that holds your OpenAI key (setup below).

Styled with the R7 Orbit design system: obsidian, ivory and one brass accent.

## Run it

It is static files with no build step. Serve the folder (opening `index.html` straight from disk will not load the film library):

```
python -m http.server 8000
```

Then open <http://localhost:8000>. Your list is saved in your browser's local storage, so it stays on that browser and device. Fonts load from Google Fonts; without a connection the page falls back to system fonts.

## The film library

`movies-db.json` is built from [Wikidata](https://www.wikidata.org), whose data is CC0 (public domain). It is a snapshot (about 23,500 films with a known length, including many 2025 and 2026 releases). It does not update itself, and very new or obscure films may be missing. You can always type any title and set its length yourself with Edit.

## Set up the chat

Why a Worker: a page in the browser cannot hold an OpenAI key safely, because anyone who opens the page could read it. The Worker keeps the key as a secret on Cloudflare. The page sends it your question and your movie history, the Worker adds the key and calls OpenAI, and only the answer comes back.

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

   Wrangler prints the Worker's address, like `https://r7-movie-wheel-chat.your-name.workers.dev`.

5. Open the app, go to **Chat**, open **Connection settings**, and paste the Worker address and your passphrase. They are saved in your browser only. To avoid typing the address on each device, put it in `config.js` instead.

### What the Worker checks

- Only the origins in `ALLOWED_ORIGINS` can call it.
- Every request needs your passphrase.
- At most 20 requests a minute per visitor (best effort). For a hard limit, uncomment the rate limiting block in `wrangler.toml`.
- Questions are capped in length and each answer is capped at 900 tokens, so a single question cannot run up a large bill.

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
- `chat.js` is the chat view, `config.js` holds an optional default Worker address.
- `movies-db.json` is the film library.
- `worker/` is the Cloudflare Worker for the chat.
