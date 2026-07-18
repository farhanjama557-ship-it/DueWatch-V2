# DueWatch

Invoice / receivables tracker. **Session 1: shell + auth + deploy.**

Stack: React + Vite · Supabase (auth + database) · custom CSS (design tokens, no Tailwind) · Inter via Google Fonts.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in your Supabase values
npm run dev
```

Required environment variables:

| Variable                 | Where to find it                                    |
| ------------------------ | --------------------------------------------------- |
| `VITE_SUPABASE_URL`      | Supabase → Project Settings → API → Project URL     |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` public key |

## Database

Run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor.
It creates `profiles`, `clients`, `invoices`, `line_items`, enables RLS
(each user sees only their own rows), and installs a trigger that
auto-provisions a profile on signup.

## Deploy to Vercel (GitHub integration)

1. Push this repo to GitHub.
2. In Vercel → **Add New… → Project** → import the repo. Framework preset is
   detected as **Vite** (see `vercel.json`).
3. **Before the first build**, go to **Settings → Environment Variables** and
   add both `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Production +
   Preview + Development).
4. Deploy. SPA routing is handled by the rewrite in `vercel.json`.

## Structure

```
src/
  main.jsx                 app entry (Router + AuthProvider)
  App.jsx                  routes: /, /invoices, /clients, /settings + /login, /signup
  index.css                design tokens + global styles
  lib/supabase.js          Supabase client (session persistence on)
  context/AuthContext.jsx  auth state + signUp / signIn / signOut
  components/
    Layout.jsx             sidebar + top bar + content shell
    Sidebar.jsx            dark 64px icon-only sidebar
    TopBar.jsx             white 56px top bar (title + avatar)
    ProtectedRoute.jsx     redirects to /login when unauthenticated
    icons.jsx              inline SVG icon set
  pages/                   Login, Signup, and placeholder screens
supabase/schema.sql        tables + RLS + signup trigger
```
