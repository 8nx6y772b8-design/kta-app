# KTA Workforce Management — v3.2.3

## Project structure

```
src/
├── App.jsx                        # Auth shell + top-level routing (~950 lines)
├── constants.js                   # Theme (T), CSS, ROLES, TRADES, ENTRY_TYPES, URLs
├── utils.js                       # Auth, hashing, email/push helpers, token signing
├── shared.jsx                     # Micro-components: Pill, Btn, Card, FL, Avatar, RolePill
├── supabaseClient.js              # DB layer: loaders, converters, upsert/delete helpers
├── webPush.js                     # Service worker + VAPID push subscription
├── package.json
├── vite.config.js
├── .env.example                   # Required environment variables
└── modules/
    ├── LoginScreen.jsx            # Login form + forgot password
    ├── TimesheetModule.jsx        # EntryForm, EntryRow, WeekCard2, TimesheetModule
    ├── TimesheetHelpers.jsx       # WeeklyHoursList, ApprovalList
    ├── UserManagement.jsx         # UserManagement, UserDetailView, CRMUsersPanel
    ├── ApprenticeEditForm.jsx     # Shared apprentice profile edit form
    ├── ApprenticeList.jsx         # Apprentice list + add/edit
    ├── CRMModule.jsx              # CRM: contacts, companies, deals, HubSpot sync
    ├── LeaveModule.jsx            # All leave request components
    ├── HSEModule.jsx              # HSE check-in form + history
    ├── PPEModule.jsx              # PPE allocation + email
    ├── ReportsModule.jsx          # Meeting reports, progress graph, PDF generation
    ├── ApprenticeDetail.jsx       # Full apprentice detail view (admin drill-in)
    ├── ApprenticeConversation.jsx # Message history with apprentice
    ├── ApprenticeDashboard.jsx    # Apprentice home screen (card grid)
    ├── AdminDashboard.jsx         # Admin dashboard + useDraggableOrder hook
    ├── MentorDashboard.jsx        # Mentor view
    ├── Notifications.jsx          # NotificationBell, BroadcastComposer, ConfidentialNotesCard
    ├── EmailsModule.jsx           # EmailActivityFeed, EmailsModule (M365 integration)
    ├── XeroModule.jsx             # Xero NZ Payroll integration
    ├── ContactUs.jsx              # Contact Us panel
    ├── ProgressReports.jsx        # Progress Reports admin module
    └── LeaveResultScreen.jsx      # Leave approve/decline result + KTAConfirmRoot
```

## Setup

```bash
cp .env.example .env
# Fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_HMAC_SECRET, VITE_VAPID_PUBLIC_KEY
npm install
npm run dev
```

## Supabase Edge Function secrets required

| Secret | Used by |
|--------|---------|
| `LEAVE_TOKEN_SECRET` | leave-action Edge Function (must match `VITE_HMAC_SECRET`) |
| `HUBSPOT_TOKEN` | hubspot-proxy Edge Function |
| `VAPID_PUBLIC_KEY` | send-push Edge Function |
| `VAPID_PRIVATE_KEY` | send-push Edge Function |

## Supabase DB columns added in v3.2.x

```sql
-- Confidential notes owner flag (replaces hardcoded email)
ALTER TABLE users ADD COLUMN is_conf_owner boolean DEFAULT false;

-- Set for the relevant admin user:
UPDATE users SET is_conf_owner = true WHERE email = 'kristeena@kta.org.nz';
```
