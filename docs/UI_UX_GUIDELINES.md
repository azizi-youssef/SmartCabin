# SmartClinic — UI/UX Guidelines and Design System

| | |
| --- | --- |
| Status | Implemented (Phase 4). Source of truth: `src/styles/globals.css` (tokens) and `src/shared/ui/` (components) |
| Date | 2026-11-10 |
| Live reference | `/fr/design-system` and `/ar/design-system` (component gallery), `/fr/design-system/shell` (workspace frame). **Development only**: both return 404 in production |

---

## 1. Principles

1. **Operations first.** Screens are built around front-desk and doctor tasks: the next patient, today's agenda, booking in a few clicks. Information comes before decoration.
2. **Dense but readable.**
   - Body text: 14 px. Table rows: 40 px. Controls: 36 px.
   - One bordered surface per data region. **No grids of cards.**
   - Hierarchy comes from type, spacing and dividers.
3. **Calm and trustworthy.**
   - White and cool-neutral surfaces.
   - Deep navy for structure and primary actions; muted teal as the accent.
   - No gradients, no decorative illustrations, no shadows on resting surfaces.
4. **Honest data.**
   - Every figure comes from the database.
   - When there is nothing to show, the UI says why: empty state, error, or "service unavailable".
   - **A missing value is "—", never an invented number.**
5. **Bilingual by construction.**
   - French and Arabic share one interface, mirrored through logical CSS properties.
   - There is no hard-coded UI text.

---

## 2. Design tokens

All colors are CSS variables (`--sc-*`) mapped to Tailwind utilities through `@theme inline`. Components use **semantic** utilities only, such as `bg-surface`, `text-ink-muted` or `border-line`, never raw hex values.

### 2.1 Palette

| Role | Token / utility | Value | Use |
| --- | --- | --- | --- |
| Canvas | `bg-canvas` | `#f5f7f9` | App background behind surfaces |
| Surface | `bg-surface` | `#ffffff` | Tables, panels, dialogs |
| Surface muted / sunken | `bg-surface-muted` / `bg-surface-sunken` | `#fbfcfd` / `#eef1f4` | Table headers, hovers, skeletons |
| Line | `border-line` / `border-line-strong` | `#e1e6eb` / `#cbd3db` | Dividers / control borders |
| Ink | `text-ink` / `-muted` / `-subtle` | `#141c24` / `#4d5966` / `#687684` | Primary / secondary / tertiary text |
| Primary (navy) | `bg-primary` | `#10283b` | Primary buttons, selected slot |
| Navigation | `bg-nav` | `#10283b` | Navigation rail |
| Accent (teal) | `text-accent`, `bg-accent-soft`, `border-accent-line` | `#23766f` / `#eef7f6` / `#acd8d2` | Links, focus, current selection, "next patient" |
| Focus | `--sc-focus` | `#2f8f86` | The single focus ring (`focus-ring` utility) |
| Success | `text-success`, `bg-success-bg` | `#17663f` / `#eaf6ef` | Completed, active clinic |
| Warning | `text-warning`, `bg-warning-bg` | `#8a4f00` / `#fdf4e3` | Waiting for action, pending approval, overbooking |
| Danger | `text-danger`, `bg-danger-bg` | `#a61f29` / `#fcedee` | Errors, no-show, destructive actions |
| Info | `text-info`, `bg-info-bg` | `#1b578f` / `#ebf2fa` | Confirmed (scheduled), notices |

Every status text/background pair reaches at least 4.5:1 contrast. Status is **never** conveyed by color alone: badges always carry text, and errors carry an icon and text.

### 2.2 Status colors (one meaning, every screen)

| Appointment status | Tone | Reason |
| --- | --- | --- |
| `pending` (À confirmer) | warning | Someone must act |
| `confirmed` (Confirmé) | info | Scheduled |
| `checked_in` (Arrivé) | accent | In the building |
| `in_progress` (En consultation) | navy | With the doctor |
| `completed` (Terminé) | success | Done |
| `cancelled` (Annulé) | neutral | Inactive |
| `no_show` (Absent) | danger | Missed |

Clinic status uses the same tones: `pending_approval` warning, `active` success, `suspended` danger, `closed` neutral. The mapping lives in `modules/appointments/domain/status.ts` (`STATUS_TONE`) and is tested.

### 2.3 Typography

**Typefaces.** IBM Plex Sans + **IBM Plex Sans Arabic**. They are one family designed for both scripts, with matching proportions and weights 400/500/600. The fonts are self-hosted at build time (`next/font`).

| Utility | Size / line | Weight | Use |
| --- | --- | --- | --- |
| `text-display` | 24 / 32 | 600 | Key figures (metric strip) |
| `text-title` | 20 / 28 | 600 | Page title (one per page) |
| `text-heading` | 16 / 24 | 600 | Section and dialog titles |
| `text-body` | 14 / 20 | 400 | Default UI text |
| `text-small` | 13 / 18 | 400 | Secondary lines, hints, errors |
| `text-caption` | 12 / 16 | 500 | Column headers, badges, labels |

**Typography rules:**
- Times, amounts and file numbers use **tabular figures** (`tabular`, or automatically inside `<time>`).
- Arabic gets a line-height of 1.6.
- Uppercase is used only for Latin navigation group labels, never in Arabic.

### 2.4 Spacing, size, radius, elevation

- **Spacing:** 4 px scale. Gaps used: 4/6/8/12/16/20/24 px. Page gutter: 16 px on phones, 24 px from `sm`.
- **Controls:** 32 px (`sm`), 36 px (default), 40 px (`lg`, auth forms). 44 px for one-time-code inputs.
- **Radius:** 4 px (badges), 6 px (controls), 8 px (surfaces, dialogs). No pills.
- **Elevation:** borders for resting surfaces. Shadows only for floating layers (`shadow-popover`, `shadow-dialog`).

---

## 3. Layout

| Breakpoint | Shell behaviour |
| --- | --- |
| < 1024 px | Top bar with a menu button; the navigation rail becomes a drawer on the **inline-start** side (right in Arabic) |
| ≥ 1024 px | Fixed 240 px navy rail + 56 px white top bar + canvas content (max 1536 px) |

- **Top bar:** clinic (switcher for multi-clinic users), today's date in the clinic's time zone, language, account menu.
- **Workspace banner:** directly under the top bar for clinic-wide conditions (pending approval, suspended).
- **Page structure:** `PageHeader` (meta, title, actions on the inline-end side) → `MetricStrip` (optional) → `Section`s.
- **Patient portal:** a mobile-first single column (max 672 px) with a light header.
- **Sign-in screens:** a centered 384 px panel.

---

## 4. Components (`src/shared/ui`)

| Component | File | Rules |
| --- | --- | --- |
| `Button` | `button.tsx` | Variants: `primary` (one per area), `secondary`, `ghost`, `danger`, `danger-outline`, `link`. `loading` disables and shows a spinner. Labels name the action ("Annuler le rendez-vous", never "OK") |
| `Input`, `Textarea`, `Select`, `Checkbox`, `Label` | `form-controls.tsx` | Native elements (keyboard, screen readers, mobile pickers, RTL). Select chevron on the inline end |
| `Field`, `FieldGrid` | `field.tsx` | Label + control + hint/error with `aria-describedby`, `aria-invalid`, `aria-required`. The error replaces the hint. At most two columns |
| `Badge` | `badge.tsx` | Tones: neutral, info, success, warning, danger, accent, navy. Optional dot |
| `DataTable`, `TableFrame`, `TableSkeleton`, `CellStack` | `data-table.tsx` | 40 px rows, sticky header, caption, logical alignment, `hideBelow` for secondary columns, toolbar and footer inside the frame, skeleton with the same geometry |
| `Dialog`, `DialogContent` | `dialog.tsx` | Task dialogs: header, scrollable body, footer actions. Bottom sheet on phones |
| `ConfirmDialog` | `confirm-dialog.tsx` | Consequential actions (see §5.3) |
| `DropdownMenu*` | `dropdown-menu.tsx` | Menus (language, account, clinic switcher) |
| `ToastProvider`, `useToast` | `toast.tsx` | Short confirmation after an action; announced politely to screen readers |
| `EmptyState`, `ErrorState`, `UnavailableState`, `InlineAlert`, `Skeleton` | `states.tsx` | §5.4 |
| `PageHeader`, `Section`, `MetricStrip`, `DetailList`, `Avatar` | `layout.tsx` | Flat structure, not cards |
| `AppShell` | `app-shell.tsx` | Navigation rail, drawer, top bar, banner, main landmark |

**Module boundaries.** Lint enforces that design-system components never import business modules or Supabase. Domain-specific UI lives in `src/modules/<module>/ui/`, for example `AppointmentStatusBadge`, `BookingDialog`, `SlotPicker`, `CreatePatientDialog`.

---

## 5. Patterns

### 5.1 Tables

- One table per data region. The toolbar (day navigation, filters, search) sits inside the frame, and the footer (counts, notes) too.
- **Columns:**
  - the primary identity (patient) is flexible;
  - time and status have fixed widths;
  - secondary columns hide on small screens (`hideBelow`);
  - row actions sit at the end, with icons plus text from `xl`.
- **Row actions** are only those valid for the row's status (`availableActions`). The database validates them again.
- **Search** is server-side (`?q=`). A result list is capped at 50 rows, with a "refine your search" message instead of endless loading.
- Cancelled and absent rows are muted, not hidden.

### 5.2 Forms

- **Validation:**
  - React Hook Form + Zod, with **the same schema** as the Server Action (`modules/*/schemas.ts`);
  - validation on blur, then on change;
  - server errors are mapped to fields when possible, otherwise shown as one alert above the actions.
- **Structure:** short fieldsets with legends (Identity / Contact / Consents). Optional fields say "facultatif". Required fields carry a `*`.
- **Inputs:**
  - phones accept local formats (`06 12 34 56 78`) and are normalized to E.164 on the server;
  - phone and email fields are `dir="ltr"`, also in Arabic;
  - Arabic-name fields are `dir="rtl"`, also in French.
- **Bookings** carry an idempotency key generated when the dialog opens, so a double click cannot create two appointments.

### 5.3 Dialogs and confirmations

- **Task dialog** (`DialogContent`): forms and pickers. Title, short description, actions at the end of the footer: secondary (Annuler), then primary.
- **Confirmation** (`ConfirmDialog`), for cancel, no-show, suspend, close:
  - the title asks the question ("Annuler ce rendez-vous ?");
  - the description states the consequence ("Le créneau sera libéré ; l'annulation reste dans l'historique.");
  - the confirm button repeats the action;
  - the cancel button names the safe choice ("Garder le rendez-vous");
  - extra inputs (a reason) go inside, and confirm stays disabled until they are valid;
  - **on failure the dialog stays open and shows the error**, and it closes only on success;
  - destructive actions use the `danger` tone.

### 5.4 Loading, empty and error states

| State | Component | When | Content |
| --- | --- | --- | --- |
| Loading | `TableSkeleton`, `Skeleton`, `Button loading` | Client-side fetches (slots, patient lookup) and pending actions | Same geometry as the content; `aria-busy` |
| Empty | `EmptyState` | A successful query with no rows | What is empty + the next useful action ("Créez un rendez-vous ou choisissez un autre jour.") |
| Error | `ErrorState` | A domain error code | Localized message from `errors.<CODE>`; never a raw database message |
| Forbidden | `ErrorState` | `FORBIDDEN` | "Votre rôle ne donne pas accès à cette page." |
| Unavailable | `UnavailableState` | Backend not configured or unreachable | Says so plainly; **no placeholder data** |

Data loaders return `Loaded<T>` (`ok | unavailable | error`), and pages render each case explicitly.

### 5.5 Feedback after actions

- Success: a toast ("Rendez-vous confirmé"), then `router.refresh()` reloads server data.
- Conflict (`STALE_STATE`, `SLOT_UNAVAILABLE`): the message explains, and the data is refreshed or the slot list reset.

---

## 6. Localization and RTL

- **Locales and routing:**
  - `fr` (default) and `ar` live in the URL (`/fr/…`, `/ar/…`);
  - the choice persists in the `SC_LOCALE` cookie;
  - the language switch keeps the current page.
- **Dictionaries:**
  - `messages/fr.json` and `messages/ar.json`;
  - a test enforces identical keys, identical ICU placeholders, no empty message, and Arabic script in more than 90 % of the Arabic messages;
  - Arabic plurals use the full CLDR categories (`zero/one/two/few/many/other`).
- **Direction:**
  - `<html lang dir>` is set per locale, and Radix `Direction.Provider` mirrors menus and dialogs;
  - layout uses logical utilities only (`ms-*`, `pe-*`, `start-*`, `end-*`, `text-start`, `border-e`);
  - directional icons (chevrons, sign-out arrow) use `flip-rtl`.
- **Numbers and dates:**
  - Western digits in both languages (`fr-MA-u-nu-latn`, `ar-MA-u-nu-latn`, decision A16);
  - 24-hour clock;
  - dates and times are always formatted in the **clinic's** time zone (`shared/lib/format.ts`);
  - money is MAD from decimal strings.
- **Mixed-direction text:** emails, phone numbers and slugs are isolated with `dir="ltr"` inside Arabic text.
- **Arabic copy** must be reviewed by a native speaker before the pilot (audit R13).

---

## 7. Accessibility checklist (applied)

- [x] Skip link to `#main`; landmarks (`nav` with a label, `main`, `header`).
- [x] One visible focus treatment (`focus-ring`, teal) on every interactive element.
- [x] Native form controls; labels wired; errors announced (`role="alert"`) and tied by `aria-describedby`.
- [x] Tables have captions, `scope="col"` headers, and text alternatives for icon-only buttons.
- [x] Dialogs trap focus, close on Escape, and have titles and descriptions (Radix).
- [x] Status = text + color. Contrast ≥ 4.5:1 for text pairs.
- [x] `prefers-reduced-motion` disables animations.
- [ ] Formal axe and screen-reader audit: to run once the workspaces are connected to a live backend (Phase 7).

---

## 8. What we avoid (and what we do instead)

| Avoid | Instead |
| --- | --- |
| Grids of KPI cards | One `MetricStrip` with dividers |
| Card around every heading | Flat `Section` with space; one bordered surface per data region |
| Decorative gradients, glows, illustrations | Flat surfaces, a single accent color |
| Sample charts or invented statistics | Counts computed from records; "—" when not measurable |
| Generic "Submit/OK" buttons | Verb + object ("Créer le rendez-vous") |
| Buttons for features that do not exist yet | No button; a one-line note where the next module will appear (e.g. check-in arrives with SmartFlow) |
| Physical left/right CSS | Logical properties; direction-independent centering only |
