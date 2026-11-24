# Barber booking website

A white-label booking website and admin dashboard for barbershops, ready to be branded for any salon.

**Live demo:** https://zeyd-barber.pages.dev · **Dashboard:** https://zeyd-barber.pages.dev/admin

## Features

**For customers**
- Online booking: service, barber, day and a free time slot, in a few taps
- Customer account with email confirmation, password reset and booking history
- Add the appointment to Google Calendar
- Favourites, loyalty points and messages with the salon
- Installable app (PWA) on Android, iPhone and desktop
- French and Arabic (right-to-left) interface, mobile-first design, optional interface sounds

**For the salon**
- Dashboard: today's appointments, customers, services, prices and opening hours
- Configurable opening hours and slot length
- Separate installable dashboard app

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, vanilla JavaScript (ES modules), no build step |
| Backend | Supabase: PostgreSQL, Auth, Row Level Security |
| Email | Supabase Auth with SMTP (Brevo), custom French templates |
| Hosting | Cloudflare Pages |
| Quality | Biome (lint and format), Node test runner with PGlite (in-memory Postgres) |

## Security

- Every table is protected by Row Level Security; staff and admin rights are checked in the database
- New accounts are always customers: a user can never change their own role
- Only the public (publishable) key is in the frontend; no secret key ever leaves the server

## Run locally

```bash
npm install
npm test        # business rules and database policies (offline, in-memory Postgres)
npm run check   # lint and format
```

Serve the `Zeyd/` folder with any static server (for example VS Code Live Server).

## Project structure

```
Zeyd/                 website and dashboard (HTML, CSS, JS modules)
supabase/migrations/  database schema, policies and functions
tests/                automated tests
docs/                 setup guides
```
