# Guest Settings Page — Design Spec

**Author**: Dex
**Task**: T#574
**Thread**: #420
**Type**: UI/UX Design Spec

---

## Overview

A guest-scoped settings page where guests can manage their own profile and account. Single scrollable page — no tabs, no complexity. Guests don't need a dashboard, just their own corner.

**Route**: `/settings` (guest version — same route, different content based on role)

---

## Layout: Single Column, Scrollable

Clean vertical flow. Each section has a heading, fields, and a save button.

### 1. Profile Section

- **Avatar**: clickable circular image (80px). Click to upload new image. Shows current or letter placeholder.
- **Display Name**: text input, pre-filled
- **Bio**: textarea (3-4 rows), placeholder: "Tell the pack about yourself"
- **Interests**: comma-separated text input or tag input, placeholder: "What are you into?"
- **Save Profile** button (accent color)

### 2. Account Section

- **Username**: read-only display (cannot change)
- **Change Password**: current password + new password + confirm new password fields
- **Change Password** button (accent color)

---

## Visual Treatment

- Max-width container (600px), centered
- Card-style sections with subtle background (slightly elevated from page)
- 24px gap between sections
- Section headings: 18px, bold
- Consistent with Den Book form styling (same input heights, border radius, focus states)
- Success toast on save, inline error messages on validation failure

---

## Mobile

- Full width, no side margins (16px padding)
- Avatar upload: centered above form fields
- Same vertical flow — already single column, so mobile is natural

---

## API Endpoints

### `GET /api/guest/profile`
Returns current guest's profile data (bio, interests, avatar, display_name).

### `PATCH /api/guest/profile`
Update bio, interests, display_name, avatar. Validates session — guests can only edit their own profile.

### `POST /api/guest/avatar`
Upload profile image. Returns URL. Size limit: 2MB. Formats: jpg, png, webp.

### `POST /api/guest/change-password`
Fields: current_password, new_password. Validates current password before changing.

---

## Security

- All endpoints scoped to authenticated guest session
- Guests can only modify their own data
- Password change requires current password verification
- Avatar upload: validate file type and size server-side
- No access to owner or beast settings from this route
