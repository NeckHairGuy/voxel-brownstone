# Voxel Brownstone — Brooklyn Block

An interactive multiplayer voxel-art scene built with three.js, contained in a single HTML file:

- A detailed Brooklyn brownstone with furnished interiors on every floor
- A corner deli building with a striped awning, apartments, roof terrace, and water tower
- A construction site with a tower crane, scaffolding, and machinery
- Day/night cycle, dollhouse facade toggle, animated traffic lights
- **Click any voxel to explode it** — debris cubes tumble with real collision against
  the voxel grid and settle back into the world as permanent rubble
- **Load-bearing collapse** — structures cut off from the ground break loose and
  fall as rigid pieces, landing intact or shattering into debris (blow out the
  crane mast or the water-tower legs)
- **Three scenes** (synced in multiplayer): *default Brooklyn*; *Tech Brooklyn*,
  which fills the far side of the street with the 7-story VOXL tower (every
  floor furnished and walkable, stairs to the helipad roof) and the FLEX luxury
  gym with a rooftop pool, plus a cybertruck and robotaxi at the curb; and
  *Tech Brooklyn Long*, which instead extends the street east so all five
  buildings line the same side
- **Isometric camera** toggle for the orbit/corpo view
- Collapsible control panels (handy on mobile)

## Multiplayer — humans vs the corpo

Served through `server.mjs` (which doubles as a zero-dependency WebSocket game
server), the scene becomes a game. Join from the panel in the top right:

- **Corpo** (1 seat): keeps the orbit/zoom camera, and is the only role with
  the explosion ability. Clicking a human figure **lays them off** — the figure
  goes up in flame and disappears. +50 points per layoff.
- **Humans** (up to 4 seats): each possesses an FPV figure and earns
  **1 point per second alive**. Laid-off humans can respawn after 10 s.
- Everyone else spectates in the free orbit camera; the panel shows a live
  **connected head-count** so you can watch the room fill up. Connections are
  capped at 400 (`MAX_CONNS` env to change).

The roster, roles, and live scores are shown in the top-right panel. World
destruction is synchronized — explosions are broadcast and replayed to anyone
who joins late. Opening `brownstone.html` directly (no server) gives the
offline sandbox where all abilities are available.

## Run locally

```sh
npm start            # serves on http://127.0.0.1:3101 (HTTP + WebSocket)
PORT=8080 npm start  # custom port
```

Or open `brownstone.html` directly in a browser for the offline sandbox.

## Controls

- drag — orbit · scroll — zoom · right-drag — pan · **click — explode**
- **FPV mode** (button in the panel): possess a red voxel figure — WASD to move,
  shift to run, space to jump, mouse to look, click to explode at the crosshair,
  esc to exit. The figure **auto-ducks** through tight stairwell headroom and
  gets nudged through narrow doorways; ctrl/C still crouches deliberately
  (slower, one voxel shorter). Doors ghost transparent and can be walked
  through. **V toggles a third-person chase camera** (walls pull it in, never
  through). On mobile, joining as human brings up touch controls: a virtual
  joystick (full tilt sprints), drag to look, and jump / crouch / **3P camera**
  buttons.
- Time-of-day slider and `cycle day` checkbox in the panel
- URL hash presets: `#t=1290&cam=x,y,z&tgt=x,y,z&boom=x,y,z&scene=tech`

## Deployment

Pushes to `main` auto-deploy via GitHub Actions (`.github/workflows/deploy.yml`),
which SSHes to the server with a forced-command deploy key that can only
fast-forward this repo and restart the service.

No build step and no runtime dependencies; three.js is vendored in `vendor/`
and served by `server.mjs`, so a room full of phones never touches a CDN.
(The file:// offline sandbox still loads three.js from the CDN, since
browsers refuse module imports from file: origins.)
