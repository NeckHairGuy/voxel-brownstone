# Voxel Brownstone — Brooklyn Block

An interactive voxel-art scene built with three.js, contained in a single HTML file:

- A detailed Brooklyn brownstone with furnished interiors on every floor
- A corner deli building with a striped awning, apartments, roof terrace, and water tower
- A construction site with a tower crane, scaffolding, and machinery
- Day/night cycle, dollhouse facade toggle, animated traffic lights
- **Click any voxel to explode it** — debris cubes tumble with real collision against
  the voxel grid and settle back into the world as permanent rubble

## Run locally

Open `brownstone.html` directly in a browser, or serve it:

```sh
npm start            # serves on http://127.0.0.1:3101
PORT=8080 npm start  # custom port
```

## Controls

- drag — orbit · scroll — zoom · right-drag — pan · **click — explode**
- **FPV mode** (button in the panel): possess a red voxel figure — WASD to move,
  shift to run, space to jump, mouse to look, click to explode at the crosshair,
  esc to exit. Doors ghost transparent and can be walked through.
- Time-of-day slider and `cycle day` checkbox in the panel
- URL hash presets: `#t=1290&cam=x,y,z&tgt=x,y,z&boom=x,y,z`

## Deployment

Pushes to `main` auto-deploy via GitHub Actions (`.github/workflows/deploy.yml`),
which SSHes to the server with a forced-command deploy key that can only
fast-forward this repo and restart the service.

No build step and no runtime dependencies; three.js loads from a CDN.
