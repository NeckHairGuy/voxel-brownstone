# Voxel Brownstone — Brooklyn Block

An interactive multiplayer voxel-art scene built with three.js, contained in a single HTML file:

- A detailed Brooklyn brownstone with furnished interiors on every floor
- A corner deli building with a striped awning, apartments, roof terrace, and water tower
- A construction site with a tower crane, scaffolding, and machinery
- Day/night cycle, dollhouse facade toggle, animated traffic lights
- **Flame ocean** (panel toggle, per-viewer): the block stands on a
  strata-banded stone monolith rising from an endless sea of animated
  single-voxel flames that stretches past the haze in every direction,
  ringed by hazard-striped barriers — with six selectable sea palettes
  (inferno and neon vapor glow in the dark; toxic sludge, arctic melt,
  molten gold, and cold ash shade with the daylight)
- **Fog color picker** (panel, per-viewer): tint the haze and sky any
  color, or leave `auto` checked to follow the sun
- **Scan-to-play QR card** (bottom-right corner): a white card with the
  audience `/join` URL as a QR code — appears automatically on the
  operator's `?corpo=` URL for the big screen, toggleable from the panel
  for anyone else, never shown in audience mode
- **Corpo marquee**: the corpo clicks the subtle line at the top center
  of the screen and types — every keystroke is relayed live to the top
  of every connected screen, audience phones included (Enter or Esc to
  drop focus; late joiners see the current line)
- **Click any voxel to explode it** — debris cubes tumble with real collision against
  the voxel grid and settle back into the world as permanent rubble
- **Load-bearing collapse** — structures cut off from the ground break loose and
  fall as rigid pieces, landing intact or shattering into debris (blow out the
  crane mast or the water-tower legs)
- **Five scenes** (synced in multiplayer): *default Brooklyn*; *Tech Brooklyn*,
  which fills the far side of the street with the 7-story VOXL tower (every
  floor furnished and walkable, stairs to the helipad roof) and the FLEX luxury
  gym with a rooftop pool, plus a cybertruck and robotaxi at the curb;
  *Tech Brooklyn Long*, which instead extends the street east so all five
  buildings line the same side; and **Boston** — a standalone map ~1.5x the
  Brooklyn block: three Beacon-Hill bowfronts with walkable interiors (a law
  office, a bookshop with a sleeping cat, a family house climbable to its
  roof deck) and hidden walled gardens; the Common with a wadeable Frog Pond,
  swan boat, ducklings statues, gazebo, and a popcorn cart mobbed by pigeons;
  an Old-North-style church with pews, organ, stained glass, and a climbable
  steeple (two lanterns, golden cod weathervane); a crooked burying ground;
  DUNKS with a giant sprinkle donut on the roof; a T station (mind the rat,
  the board says LATE), a walk-through Green Line trolley, triple-deckers
  with climbable stacked porches under a rooftop VOXGO sign; and the HUBB
  campus — brick-podium HQ with a golden cod in the lobby, the Freedom
  Trail ending at its turnstiles, a specimen-tank lab, nap pods, a ball-pit
  conference room, an org-chart wall with fresh gaps, plus a steaming-kettle
  plaza with robo-dogs and a CHOWDAH truck; and **Boston Long** — the whole
  Brooklyn block (brownstone, deli, construction lot) plus the church,
  burying ground, DUNKS, a sunken T stop, and a triple-decker carrying the
  VOXGO sign, all lining one side of a widened street with a walk-through
  Green Line trolley parked on fresh rails
- **Isometric camera** toggle for the orbit/corpo view
- Collapsible control panels (handy on mobile)
- **The Catalogue** (`?catalog`, or the "building catalogue" button in the
  panel): every landmark building as a standalone rotating diorama —
  pick from the sidebar, scrub the time of day, toggle auto-spin, and
  peel any of the four walls off buildings with interiors, dollhouse
  style. Explosions still work. The extract/place primitives behind it
  are the seed of a future level editor that will stamp these buildings
  onto custom maps.

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
- **Audience URL**: append `/join` (or `?audience`) — e.g.
  `https://host/join` — for the link you hand a crowd: no control panels at
  all, just a centered card with a name field and a **join as human** button
  (dismissable to spectate; a "join the game" pill brings it back). The card
  tracks seat availability live and returns if the connection drops.
- **Name filter**: slurs and hate terms are refused server-side (with
  leetspeak normalization); ordinary profanity is allowed.

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
  through. On mobile, joining as human brings up touch controls: a virtual
  joystick (full tilt sprints), drag to look, and a jump button.
- Red help tips label every control; the round **?** button (bottom center)
  hides or shows them, and the choice is remembered.
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
