# Iron & Plate API

Node.js + Express + SQLite backend for the Iron & Plate gym and food tracker.
Email/password accounts, JWT auth, per-user data.

## Run

    npm install
    cp .env.example .env     # then set JWT_SECRET
    export $(grep -v '^#' .env | xargs)
    npm start                # http://localhost:3000

Requires Node 18+. Data is stored in `data/ironplate.db` (SQLite).

## Endpoints

All `/api/*` routes except auth and health need `Authorization: Bearer <token>`.
Dates are `YYYY-MM-DD`.

| Method | Path | Purpose |
|---|---|---|
| POST | /api/auth/register | `{email, password}` returns `{token}` |
| POST | /api/auth/login | `{email, password}` returns `{token}` |
| GET | /api/health | Liveness check |
| GET / PUT | /api/goals | `{cal, pro, sets}` daily targets |
| GET | /api/sets | Filters: `date`, `from`, `to` |
| POST | /api/sets | `{date, exercise, weight, reps, sets}` |
| DELETE | /api/sets/:id | Remove a set |
| GET | /api/meals | Filters: `date`, `from`, `to` |
| POST | /api/meals | `{date, name, calories, protein}` |
| DELETE | /api/meals/:id | Remove a meal |
| GET | /api/weights | All weigh-ins |
| PUT | /api/weights/:date | `{value}` saves or replaces that day |
| DELETE | /api/weights/:date | Remove a weigh-in |
| GET | /api/summary/:date | Totals, latest weight and goals for a day |
| GET | /api/progress?days=30 | Daily calories, weights, personal bests |
| GET | /api/export | All your data as JSON |
| DELETE | /api/account | Delete the account and all data |

## Connect the frontend

    const API = "https://your-server.example.com/api";
    const token = localStorage.getItem("token");
    const res = await fetch(`${API}/sets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ date: "2026-10-18", exercise: "Squat", weight: 100, reps: 5, sets: 3 })
    });

Set `CORS_ORIGIN` to your site's origin in production.

## Deploy notes

- Set `NODE_ENV=production` and a long random `JWT_SECRET`.
- Put it behind HTTPS (Render, Railway, Fly.io, or nginx).
- Keep `data/` on a persistent volume, or swap SQLite for Postgres if you scale out.
