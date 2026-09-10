# Polarin — Network Topology prototype

A single-component React prototype: isometric PoP topology on a snap-to-grid
lattice, with a service drawer, a connection drawer, and a PDF/image exporter.
No dependencies beyond React.

## Put it on StackBlitz

1. Go to https://stackblitz.com/fork/vite-react
2. Drag this whole folder into the file tree in the left sidebar
   (or replace the files one by one — `index.html`, `package.json`,
   `vite.config.js`, `src/main.jsx`, `src/App.jsx`).
3. It builds and runs on save. Hit **Share** in the top bar for a link
   anyone can open.

Alternative: push this folder to a GitHub repo and open
`https://stackblitz.com/github/<user>/<repo>` — the URL itself is shareable.

## Run it locally

```
npm install
npm run dev
```

## Deploy it properly

```
npm run build
```

Then drop the `dist` folder on Vercel or Netlify if you want a stable URL
behind Lightstorm access control.

## Notes

- All styling is inline, so there is no Tailwind or CSS build step.
- Fonts (Plus Jakarta Sans, Lato) load from Google Fonts inside the
  component. They fall back to the system sans if that is blocked.
- The PDF exporter writes the file by hand as a single-page A4 landscape
  document with the render embedded as a JPEG. No PDF library needed.
- Seed data is the `SEED` and `SEED_LINKS` arrays near the top of `App.jsx`.
  A PoP's position is its `u` (column) and `v` (row) on the lattice, both
  even. Two PoPs clash only if they share a column and sit fewer than four
  rows apart.
