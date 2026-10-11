# Vinzuu (MVP v0.4)

A customer types a plate number. The system identifies the car, finds the exact spare part number for it,
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
| Shop console | `/shop.html` | Shops: add parts, update price and stock, see booking requests |
| Admin console | `/admin.html` | You: part numbers, shops, missing-part report, stats, add or remove a car |

**Admin token.** Copy `.env.example` to `.env` and set `ADMIN_TOKEN` to a long random password.
Without it the token is `dev-admin-token`, which is fine on your own laptop and nowhere else.

**Session secret.** Also set `SESSION_SECRET` in `.env` to a long random string before you share the
server with anyone. It signs the "you are signed in" cookie; the default is fine for your own laptop only.

## Customer accounts

The welcome page (`/`) lets a customer create an account or sign in with email and password. Once signed
in:
- A car they register gets saved to their account, and shows up as a row of plate chips ("my cars") the
  next time they visit, so they don't have to retype it.
- If they sign in and re-enter a plate nobody else had claimed yet, it is adopted into their account.
- A plain "Continue without an account" link on the welcome page skips straight to the plate-only flow
  from the first version of this project, unchanged, for anyone who does not want to sign up.

Passwords are hashed with `scrypt` (built into Node, no extra dependency). Sessions are a signed cookie,
not a database table, so restarting the server does not sign anyone out early.

### Google and Apple sign-in

Both are **optional**. Leave `GOOGLE_CLIENT_ID` / `APPLE_CLIENT_ID` unset in `.env` and the welcome page
just shows email sign in / create account — no broken buttons. Add one and its button appears automatically.

**Google** (works on `localhost` for testing):
1. Go to https://console.cloud.google.com/apis/credentials, create an **OAuth 2.0 Client ID** of type
   "Web application".
2. Under "Authorized JavaScript origins" add `http://localhost:3000` (for testing) and your real domain
   once you deploy.
3. Copy the client ID into `.env` as `GOOGLE_CLIENT_ID`.

**Apple** (needs a real deployed domain — it cannot be tested on `localhost`; Apple does not accept
`localhost` as a redirect target):
1. You need a paid Apple Developer account. Create a **Services ID** in
   https://developer.apple.com/account/resources/identifiers/list/serviceId, enable "Sign in with Apple",
   and configure it with your deployed domain and a return URL.
2. Copy the Services ID into `.env` as `APPLE_CLIENT_ID`, and the return URL as `APPLE_REDIRECT_URI`.
3. Deploy the site and test there. Until then, the Apple button simply stays hidden.

The server verifies both providers' sign-in tokens itself (checking the signature against Google's/Apple's
published public keys) rather than trusting whatever the browser sends — see `lib/auth.js`.

## Try it with the demo data

The first start loads **invented** demo data: fake shops, fake prices, and part numbers that all start with
`DEMO-`. A yellow banner on every page says so. None of it is real.

| Try this | What it shows |
|---|---|
| Plate `RXA002B`, part **Front Bumper** | A Korea-built Kia Sportage gets part `DEMO-KIA-QL-FB-KR` |
| Plate `RXA003C`, part **Front Bumper** | The same model built in the USA gets a different part, `DEMO-KIA-QL-FB-US` |
| Plate `RXA001A`, part **Front Brake Pad** | Three shops, three different trust labels |
| Any plate not listed, for example `RXC777Z` | The "we do not know this car yet" registration form |
| Search "brake noise" | Symptom search finds the brake pads |
| Sign up on the welcome page, then register a car | The car is saved to your account; "Change car" now shows it as a tap-to-select chip |
| Shop console, code `111111` to `555555` | Sign in as a demo shop |
| Admin console, your admin token, **Cars** tab | Add, correct, or delete a car directly |

The demo plates use the `RXA` series, which Rwanda has not issued, so they cannot belong to a real car.

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
| Customer accounts, sessions, Google/Apple sign-in | `lib/auth.js` |

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
- **Apple sign-in cannot be tested on localhost.** See "Google and Apple sign-in" above.
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
lib/auth.js          passwords, session cookies, Google/Apple sign-in verification
public/              the web pages (welcome, customer, shop, admin), scripts, styles, fonts
test/api.test.js     the test suite
scripts/reset-db.js  deletes the local database
```
