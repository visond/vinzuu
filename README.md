# Vinzuu (MVP v0.4)

A customer types their car's VIN (the 17-character vehicle identification number). The system identifies the car, finds the exact spare part number for it,
shows which Kigali shops have it in stock (price, distance, trust label), and lets the customer book a
garage to fit it.

The project is named Vinzuu (from VIN, the vehicle identification number the matching is built around). To
rename it again later, change `APP_NAME` in `server.js`, the `<title>` and `.brand` text in each HTML file
under `public/`, and the name in `package.json`.

## Run it

You need **Node.js 22.13 or newer** (check with `node --version`; the current LTS from https://nodejs.org works).
No database to install: SQLite is built into Node.

```
npm install
npm start
```

Then open http://localhost:3000

| Page | Address | Who uses it |
|---|---|---|
| Welcome / sign in | `/` | Everyone starts here: sign in, or create an account |
| Customer app | `/index.html` | Car owners: find parts, book installation, see "my cars" if signed in |
| Sell on vinzuu | `/sell.html` | Parts shops and garages apply to join (RDB TIN, certificate and front photos) |
| Vinzuu Sellers & Garages | `/business.html` | Approved shops and garages: parts (price and stock), part requests, bookings, jobs, labour prices, reviews |
| Admin console | `/admin.html` | You: applications, customer reports, parts, shop and garage scorecards (edit, suspend), accounts (block), bookings (filter, cancel), reviews, part numbers, charts, admin log, CSV downloads |

**Who can post parts.** Only an admin account. A shop asks for a part from "Request a part"; an admin checks
the photo, part number and price, then approves it. Shops change only their own price and stock.

**Switching places.** Signing in takes each account to its own home: an admin to `/admin.html`, a shop or
garage to `/business.html`, a customer to their garage. Shop, garage and admin accounts get an account menu
(click their name) to switch: an admin to Sellers & Garages (opening any shop or garage read-only, to see what
its owner sees) or the customer site; a shop or garage to the customer site. Customers have no such menu.

**Admin account.** Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`: the server makes that account an
admin when it starts. With demo data, `admin@vinzuu.rw` / `Admin-vinzuu1` also works. The old
`ADMIN_TOKEN` header still works for scripts (default `dev-admin-token`, laptop only).

**Session secret.** Also set `SESSION_SECRET` in `.env` to a long random string before you share the
server with anyone. It signs the "you are signed in" cookie; the default is fine for your own laptop only.

## Customer accounts

The welcome page (`/`) lets a customer create an account or sign in with email and password. Once signed
in:
- A car they register gets saved to their account, and shows up as a row of plate chips ("my cars") the
  next time they visit, so they don't have to retype it.
- If they sign in and re-enter a VIN nobody else had claimed yet, that car is adopted into their account.
- The VIN box on the welcome page, and a plain "Continue without an account" link in the sign-in box, go
  straight to the customer app for anyone who does not want to sign up.
- The plate is still asked for when a car is registered, but only as a label: typing a plate never looks a
  car up, because a plate in Rwanda can move to a different car. The VIN is what finds the car.

Creating an account asks for a full name, email, an optional phone number, and a password typed twice.
New passwords need at least 8 characters, an uppercase letter, a number and a special character (checked
in the browser and again on the server). Accounts made before this rule can still sign in.

Passwords are hashed with `scrypt` (built into Node, no extra dependency). Sessions are a signed cookie,
not a database table, so restarting the server does not sign anyone out early.

### Google sign-in

**Optional.** The sign-in box always shows "Continue with Google", but until `GOOGLE_CLIENT_ID` is set in
`.env`, tapping it just says Google isn't available yet and points people to email. Set it and the
button starts working automatically. It works on `localhost`, so you can test it before deploying.

1. Go to https://console.cloud.google.com/ and create a project (for example "Vinzuu").
2. Open **APIs & Services → OAuth consent screen** (newer consoles call it **Google Auth Platform**).
   Choose **External**, fill in the app name, support email and developer email, and save.
   While the app is in "Testing", only the Google accounts you add under **Test users** can sign in.
   Click **Publish app** when you want anyone to be able to.
3. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**. Choose
   **Web application**.
4. Under **Authorized JavaScript origins** add `http://localhost:3000` and `http://localhost` (Google
   needs both for local testing), plus your real domain (for example `https://your-domain.example`) once you deploy.
   No redirect URIs are needed.
5. Copy the client ID (it ends in `.apps.googleusercontent.com`) into `.env` as `GOOGLE_CLIENT_ID`,
   then restart the server.

The client ID is not a secret (it is visible in the page), so there is no client secret to store.
The server verifies every Google sign-in token itself, checking the signature against Google's
published public keys, rather than trusting whatever the browser sends; see `lib/auth.js`.

## Try it with the demo data

The first start loads **invented** demo data: fake shops, fake prices, and part numbers that all start with
`DEMO-`. A yellow banner on every page says so. None of it is real.

| Try this | What it shows |
|---|---|
| **Try a demo car** link under the VIN box (homepage or customer app) | Opens the demo Toyota RAV4 in one tap |
| VIN `JTMBK31V996054321` (the example VIN shown in the box), part **Front Brake Pad** | Toyota RAV4 (plate `RXA001A`): three shops, three different trust labels |
| VIN `KNDPM3AC8J7100002`, part **Front Bumper** | A Korea-built Kia Sportage (plate `RXA002B`) gets part `DEMO-KIA-QL-FB-KR` |
| VIN `5XYPG4A38JG100003`, part **Front Bumper** | The same model built in the USA (plate `RXA003C`) gets a different part, `DEMO-KIA-QL-FB-US` |
| VIN `KMHJ3813DHU100004` | Hyundai Tucson (plate `RXA004D`) |
| Any other valid VIN, for example `JTMBK31V996000999` | The "we do not know this VIN yet" registration form |
| Search "brake noise" | Symptom search finds the brake pads |
| Sign up on the welcome page, then register a car | The car is saved to your account; "Change car" now shows it as a tap-to-select chip |
| `/business.html`, `shop1@vinzuu.rw` to `shop5@`, password `Vinzuu-demo1` | Sign in as a demo shop |
| `/business.html`, `garage1@vinzuu.rw` to `garage3@`, or `both@vinzuu.rw` | A demo garage, or an account with both sides |
| `/admin.html`, `admin@vinzuu.rw` / `Admin-vinzuu1`, **Cars** tab | Add, correct, or delete a car directly |
| `/admin.html`, **Reports** tab | A demo customer's report about a shop's price, to look into and close |
| Sign in as `customer@vinzuu.rw`, password `Vinzuu-demo1`, then try the demo car | A customer with past bookings, to rate or report |

The demo plates use the `RXA` series, which Rwanda has not issued, so they cannot belong to a real car. The
demo VINs are invented too. A demo database created before the demo cars had VINs gets them filled in on the
next start.

**To start clean (real use):** stop the server, run `npm run reset-db`, then `npm run start:real`.

## Run the tests

```
npm test
```

37 tests cover the algorithms, the trust rules, privacy, access control, accounts, and the admin
add/correct/delete-a-car endpoints. Several were checked by deliberately breaking the rule in the code and
confirming the test failed.

## How it maps to the specification

| Spec | Where |
|---|---|
| Algorithm A: vehicle registration, VIN and WMI decode | `lib/algorithms.js` (`decodeWmi`), `POST /api/vehicles/register` |
| Algorithm B: vehicle to OE part number, with safe fallback | `lib/matching.js` (`findCompatible`) |
| Algorithm C: part number to shops in stock | `lib/matching.js` (`resolveListings`) |
| Algorithm D: distance ranking | `lib/algorithms.js` (`haversineKm`) |
| Algorithm E: confidence to customer badge | `lib/algorithms.js` (`badgeFor`) |
| Database schema | `db.js` |
| REST API | `server.js` |
| Customer accounts, sessions, Google sign-in | `lib/auth.js` |

Safety rules worth knowing:

- **Origin market and generation are never relaxed.** If the engine is unknown the system shows close matches marked
  Unverified. If the build country is unknown and parts differ by country, it asks instead of guessing.
- **Verified Genuine needs three things:** HIGH confidence, the shop says genuine, and the shop is vetted by you.
- **HIGH confidence needs a named verifier** when entered through the admin console.
- **The public API never returns a full VIN, a password, or an owner's phone number.**
- **Customers can fill in blanks on a car record but cannot overwrite existing details.** Only an admin can.
- **A customer never sees another customer's cars.** "My cars" is always scoped to the signed-in account.
- **Admin can delete a car only if it has no booking history**, so deleting one never silently orphans a
  real booking; the database's own foreign key enforces this even if the application check is ever removed.

## Where this differs from the developer specification

These are deliberate, and each one fixes a gap in the spec:

1. `fitment_reference` has an `origin_market` column (blank means "any"). The spec's own business rules said the
   build country must affect matching but the table had nowhere to store it.
2. `shops` has `vetted` and `access_code`. The first gates the Verified Genuine label, the second is the shop login.
3. `vehicles` has `import_source`: where the owner says the car was imported from. It is not used for matching, but
   it collects real data about Rwanda's import channels that you can use in the thesis.
4. A `search_gaps` table records searches we could not answer, which powers the missing-parts report.
5. **A VIN is exactly 17 characters.** The spec allowed 18 for Korean domestic cars. That was a mistake, and the
   code enforces 17 (the letters I, O and Q are never used).
6. `GET /api/parts/listings` also accepts `plate_number`, so a "close match" stays marked Unverified on the results
   screen, and `part_category` for universal parts (wipers, oil, batteries).
7. **New since the original MVP:** a `users` table and customer accounts (not in the original spec at all), and
   `vehicles.user_id` linking a car to the account that registered it.

## Known limits (this is an MVP, not production)

- **The WMI table is a starter list.** `lib/algorithms.js` lists the codes for Toyota, Hyundai and Kia written from
  public directories. Verify it against ISO 3780 or manufacturer data and extend it as you meet new codes.
- **Demo part numbers are invented.** Real fitment data has to come from manufacturer catalogues or physical checks.
  The admin console and the missing-parts report exist to help you build it.
- **Shop login is a simple access code and admin login is one token** (not an account like customers get). Fine
  for a pilot with a handful of shops and one operator, not for the public internet.
- **No "forgot password" flow yet.** If a customer forgets their password, the only fix right now is an admin
  resetting it directly in the database, or the customer signing up again with a different email.
- **Photos are stored inside the database.** Move them to file storage (Cloudinary, S3) before you have many shops.
- **WhatsApp works through pre-filled links.** The customer taps to send, so nothing is sent automatically. The
  WhatsApp Business API is the upgrade path.
- **SQLite on one server.** Fine for a pilot. The schema moves to PostgreSQL with small changes.
- **No visual map yet.** Shops and garages are ranked by distance in a list, with no map view. The data is
  already there (every shop and garage has latitude/longitude, and distance is already computed server-side),
  so this is a frontend addition, not a redesign. Recommended path: Leaflet + OpenStreetMap, which is free
  and needs no API key, rather than the Google Maps JavaScript API, which has required a billing account
  (credit card on file) since Google's March 2025 pricing change, with 10,000 free map loads a month and
  roughly $7 per 1,000 after that. Worth revisiting if the project later wants Street View or satellite imagery.
- **Not built yet:** shops suggesting new part numbers (with auto-upgrade to MEDIUM when a second shop confirms),
  booking status updates, Kinyarwanda and French translations, SMS.

## Project layout

```
server.js            the API and web server
db.js                schema, part categories, demo data
lib/algorithms.js    pure functions: plate, VIN, WMI, distance, badges
lib/matching.js      database algorithms: part lookup, shop listings, catalog
lib/auth.js          passwords, session cookies, Google sign-in verification
public/              the web pages (welcome, customer, shop, admin), scripts, styles, fonts
test/api.test.js     the test suite
scripts/reset-db.js  deletes the local database
```
