---
title: Privacy policy
description: How Pboard handles local board data, Google Drive access, sharing, retention, and deletion.
permalink: /privacy/
---

# Pboard Privacy Policy

Last updated 6 November 2026

Publisher: Stefano Gozzi

Privacy contact: [stefanogozzi@gmail.com](mailto:stefanogozzi@gmail.com)

Pboard is a browser extension for organizing projects, notes, links, and images. It saves your data on your device first. Google Drive backup, synchronization, and board sharing are optional. This policy explains what information Pboard handles, how it uses that information, and how you can control it.

## Information Pboard handles

Pboard stores the content you create or choose to capture: project names, board settings, card text, categories, statuses, ordering, selected text, links, page titles, source URLs, images, and page regions you capture. It also stores preferences and technical information needed to save and synchronize your boards, such as record identifiers, timestamps, revisions, and deletion records.

Page capture happens when you invoke a Pboard capture action. Pboard can inspect the current selection and focused link to make capture controls available. It does not collect your browsing history or automatically copy entire conversations. Captured images or page regions can contain personal information visible on the page you choose to capture.

When you connect Google Drive, Pboard handles authorization tokens, Pboard files and folders in Drive, file metadata, and sharing permissions. For sharing and ownership checks, it accesses your Google account email address and display name, and collaborators' email addresses, display names, and roles when provided by Google. It also handles email addresses you enter to invite collaborators.

## How information is used

Pboard uses this information to display and edit boards, preserve your preferences, capture content you select, copy content to your clipboard at your request, synchronize your devices, restore boards from Drive, and provide the sharing and collaboration features you enable.

Pboard has no advertising, analytics, or telemetry service. It does not sell your information, use it for advertising, or send your board content to an AI service or use it to train AI models. Copying a board to your clipboard lets you choose where to paste it; any service you paste it into handles that content under its own policies.

## Storage on your device

Boards, images, settings, and synchronization state are stored in your browser profile using extension storage and local databases. Pboard does not require a Pboard account. Your boards are never uploaded to a publisher-operated server as readable content; the one publisher-operated service Pboard can use is the collaboration relay, described under [Live collaboration and the relay](#live-collaboration-and-the-relay), and it receives only sealed operations, never plaintext.

Google authorization credentials are managed locally by the extension or the browser's identity system. They are used to communicate with Google and are not shared with collaborators or with the relay.

## Optional Google Drive access

Connecting Google Drive starts Google's authorization flow. Pboard does not receive your Google password. You can use local board features without connecting Google.

Pboard requests these permissions:

- `https://www.googleapis.com/auth/drive.appdata`: store and retrieve private Pboard backups, account preferences, and synchronization records in Drive's application data folder.
- `https://www.googleapis.com/auth/drive`: discover and work with Pboard boards shared with your account, manage Pboard shared folders and files, and manage collaborator permissions. This permission grants broad Drive access; Pboard uses it for its backup, synchronization, and collaboration features, including finding incoming shared boards.
- `tabs` (installed with the extension): read the active browser tab's address and title so "Pin current page" and the capture toolbar can detect the page you are on. It does not read tab contents.
- Optional host access for the web pages you pin from or capture: requested through an explicit prompt when you click "Pin selected text", "Pin link", or "Capture region" and the page was not opened through an action that already granted access. This access lets Pboard read the selection, link, or region on that page. You can grant it per request or revoke it at any time in your browser's extension permission settings.

Pboard creates, reads, updates, and deletes its project snapshots and related files as needed for these features. Connected boards synchronize asynchronously, including after edits and other synchronization triggers; you do not need to press a sync button for every upload. Board content and captured images can therefore leave your device while Drive is connected.

Private backups are stored in your account's application data folder. Enabling live collaboration or sharing a board creates Pboard files in a shared Drive layout. Images belonging to shared boards are transferred through their shared Drive folder.

Pboard's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Google data is used only to provide the features described here. The publisher does not routinely receive or read your Drive or board content.

Pboard's use of user data complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting-user-privacy), including the Limited Use requirements.

## Sharing and live collaboration

When you share a board, people with access can receive its content, images, and source metadata according to their permissions. Pboard uses Google Drive sharing permissions to manage owner, editor, and viewer access. Sharing information, such as collaborator names, email addresses, and roles, can be visible to people with permission to inspect the board's sharing settings.

Live collaboration exchanges board changes between connected browsers. In the extension this runs over an authenticated WebSocket to the collaboration relay described below; the Android app can additionally use WebRTC peer connections, which exchange changes directly between devices. Where WebRTC is used, Google Drive stores connection setup records, and Google and Twilio STUN servers are contacted to establish the connection; those services receive network information such as your IP address, rather than board content.

Removing a collaborator restricts future access through Pboard and Drive permissions. It cannot erase content that person has already downloaded, copied, or saved elsewhere. Share only content you intend the recipients to access.

## Live collaboration and the relay

Pboard operates a collaboration relay so that two connected browsers can exchange board changes without waiting for a Drive poll. It is an event relay, not a board store: it holds pending changes so they can be delivered and replayed, and it is not the authoritative copy of your board. The relay is used only for boards where live collaboration has been set up; other boards synchronize through Drive alone.

What the relay receives and stores:

- **Sealed operations.** Each board change is encrypted on your device with that board's content key before it is sent. The relay stores the resulting ciphertext and an ordering sequence, and replays it. It never holds the content key and cannot decrypt the operation, so it cannot read board text, card titles, images, or the board's structure. Images are not sent through the relay at all.
- **Public device keys and sealed key envelopes.** To let a second device of the same account obtain a board's content key, each device publishes a public key, and a device that holds the content key posts the key sealed to a peer's public key. The relay stores these opaque envelopes and returns only those addressed to the connection's authenticated device; it holds nothing that opens one.
- **A bounded per-account hint inbox.** To tell another account that a board was shared with it, the relay can hold small sealed hints. An inbox is addressed by a **hash** of the account's verified email address, not by the address itself, and the relay keeps no email, display name, or session-to-account map for this feature. A hint is only a notification: the receiving client still verifies the board against Drive before anything becomes available. The client half of this inbox is not connected in the shipped extension, so in normal use nothing is written to it.
- **Verified account identity, where Google account sharing is used.** Boards shared between different Google accounts use Google sign-in to prove which account a device belongs to: the client obtains a single-use admission receipt for one socket challenge, session, room and device, and the relay checks the presented Google token against Google's `/about` endpoint. The verified email address is used for that decision and for authorizing board policies; the directory that holds policies, pending device requests and admission receipts is kept **in memory** and is not written to disk. A legacy enrollment endpoint, used only by development builds of the extension, additionally reads a board's Drive file metadata and permission list with the same transient token, to derive the roles the owner set there. In no case does the relay receive your Google password, your OAuth refresh token, or a Drive access token it retains — a token is used for the verification call and then discarded.
- **Connection metadata.** As with any service you connect to, the relay and the TLS proxy in front of it process your IP address and connection timing, and the service's logs record session identifiers, room identifiers (an opaque board id or account hash), device key ids, and protocol events. Logs do not contain operation payloads or keys.

What the relay cannot do: it holds no Drive credential, so it cannot read your Drive files or confirm that a snapshot was actually written — a client's claim that it published one is recorded as an assertion rather than verified. It does not decide board membership; Drive permissions do. A sealed operation it forwards is verified by the receiving client, which rejects one it cannot decrypt or that does not match its board.

The relay is operated on the publisher's infrastructure. Using live collaboration therefore sends the data above to that service; if you do not want that, leave live collaboration off and the extension will not open the relay connection.

## Retention and deletion

Local information remains in your browser profile until you delete it or clear Pboard's local storage. Moving a card to Trash keeps it available until you permanently delete it or empty Trash. Synchronization can retain deletion markers to prevent deleted content from returning. Older local migration or recovery copies and cached images may remain until the extension's stored data is cleared.

When connected, Pboard attempts to propagate supported deletions to Drive. A deletion can remain pending while you are offline or when Google requests fail. Only owners can delete shared project content; removing another person's shared board from your project list does not delete their board. Deletion does not erase copies held by collaborators or in independent backups.

To remove all Pboard information, clear its extension storage and local databases using your browser's controls, and separately remove Pboard's Drive files and application data through Google's storage controls. Uninstalling Pboard does not delete data already stored in Google Drive.

Disconnecting Drive clears the extension's local authorization state or cached token and attempts to revoke Google authorization. It does not delete local boards or existing Drive data. You can also revoke access in your [Google Account connections](https://myaccount.google.com/connections). Revoking authorization stops future authorized access; it does not delete previously stored data.

On the relay, an operation stays until a published Drive snapshot provably covers it **and** a seven-day retention window has passed since that snapshot was recorded; only then is it eligible for the hourly pruning pass. Operations that no snapshot covers are never pruned, so a board that no device ever consolidates retains its pending operations up to the per-board cap (200,000 operations or 64 MiB per board, 512 MiB across the service) and then stops accepting new ones. Sealed key envelopes are not deleted by that pruning. Account hints expire seven days after they are written and are also evicted oldest-first when an inbox is full. Deleting a board locally or revoking a collaborator does not address a deletion request to the relay: its rows are still sealed ciphertext that the relay cannot attribute to you, and they leave when a covering snapshot plus the retention window allows, or when the cap forces the board's appends to stop.

Google and any recipients of shared content apply their own retention practices to information they hold.

## Security and other services

Pboard uses HTTPS for Google API requests. Live collaboration in the extension goes over an authenticated WebSocket secured by TLS (`wss:`), and the operations it carries are already sealed with the board's content key, so the relay holds ciphertext rather than board content. Where the Android app uses WebRTC, board transfers run on WebRTC data channels (DTLS) and the transport is end-to-end between devices; ordinary STUN/ICE connection setup traffic is not encrypted. A relay connection is refused unless it is TLS or an explicitly enabled loopback development endpoint.

Live access is authorized by signed manifests: when a board owner has pinned a security authority, participating devices hold owner-approved device keys, the relay admits a room only on a current signed manifest for that device, and receiving clients verify permissions, mutations and snapshots by signature. Boards without a pinned authority (including ordinary account synchronization of board order) do not have that device-level authentication, and the relay's admission of a room is then the only check. Snapshots stored through Google Drive remain readable by Google, and so do its copies of anything else you store there — signatures provide integrity and origin verification, not additional confidentiality. Local storage is protected by your browser and device controls; Pboard does not add a separate password or encryption layer to its local databases. Protect access to your device and Google account.

Google handles authentication, Drive storage, and related service requests under [Google's Privacy Policy](https://policies.google.com/privacy). Browser vendors, extension stores, websites you visit, and services you contact handle information under their own policies. This policy covers the Pboard extension; any future Pboard website with additional data processing will need disclosures for that processing.

## Your choices and privacy requests

You can use Pboard locally, choose what to capture, edit or delete your content, control sharing permissions for boards you own, disconnect Drive, revoke Google authorization, and clear stored data. You can copy board text through Pboard's clipboard controls.

For privacy questions or requests to exercise applicable data protection rights, contact [stefanogozzi@gmail.com](mailto:stefanogozzi@gmail.com). Because the publisher does not host your boards, it generally cannot retrieve or erase data held only on your device, in your Google account, or by collaborators. Do not send board content or credentials unless needed for a support request you choose to make.

## Changes to this policy

Updates will be published with a revised date. If Pboard introduces a new use of Google user data, users will be notified and asked for consent before that new use begins, as required by Google's policies.
