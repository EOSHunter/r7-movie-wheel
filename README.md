# R7 Movie Wheel

A wheel that picks what to watch. Keep a list of movies, give them genres, spin the wheel, and watch whatever it lands on. Mark a movie as watched and it leaves the wheel.

- Add, edit and remove movies. Edit also sets a movie's genres, including ones you type yourself.
- Filter the wheel by one or more genres in the "Spin from" row.
- Spin sounds (clicks and a landing chime) are made with Web Audio, so there are no audio files. A button turns them off.
- Styled with the R7 Orbit design system: obsidian, ivory and one brass accent.

## Run it

It is one static file with no build step. Open `index.html` in a browser, or serve the folder:

```
python -m http.server 8000
```

Your list is saved in your browser's local storage, so it stays on that browser and device.

Fonts (Cormorant Garamond, Inter, JetBrains Mono) load from Google Fonts; without a connection the page falls back to system fonts.
