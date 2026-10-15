---
title: Privacy policy
description: How Pboard handles local board data, Google Drive access, sharing, retention, and deletion.
permalink: /privacy/
---

# Pboard Privacy Policy

Last updated 13 October 2026

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

Boards, images, settings, and synchronization state are stored in your browser profile using extension storage and local databases. Pboard does not require a Pboard account and does not upload boards to a publisher-operated server.

Google authorization credentials are managed locally by the extension or the browser's identity system. They are used to communicate with Google and are not shared with collaborators.

## Optional Google Drive access

Connecting Google Drive starts Google's authorization flow. Pboard does not receive your Google password. You can use local board features without connecting Google.

Pboard requests these permissions:

- `https://www.googleapis.com/auth/drive.appdata`: store and retrieve private Pboard backups, account preferences, and synchronization records in Drive's application data folder.
- `https://www.googleapis.com/auth/drive`: discover and work with Pboard boards shared with your account, manage Pboard shared folders and files, and manage collaborator permissions. This permission grants broad Drive access; Pboard uses it for its backup, synchronization, and collaboration features, including finding incoming shared boards.

Pboard creates, reads, updates, and deletes its project snapshots and related files as needed for these features. Connected boards synchronize asynchronously, including after edits and other synchronization triggers; you do not need to press a sync button for every upload. Board content and captured images can therefore leave your device while Drive is connected.

Private backups are stored in your account's application data folder. Enabling live collaboration or sharing a board creates Pboard files in a shared Drive layout. Images belonging to shared boards are transferred through their shared Drive folder.

Pboard's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Google data is used only to provide the features described here. The publisher does not routinely receive or read your Drive or board content.

Pboard's use of user data complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting-user-privacy), including the Limited Use requirements.

## Sharing and live collaboration

When you share a board, people with access can receive its content, images, and source metadata according to their permissions. Pboard uses Google Drive sharing permissions to manage owner, editor, and viewer access. Sharing information, such as collaborator names, email addresses, and roles, can be visible to people with permission to inspect the board's sharing settings.

Live collaboration exchanges board changes between connected browsers using WebRTC. Google Drive stores connection setup records. These records can contain session identifiers and network connection information, including IP addresses. Connected peers may learn each other's network addresses. The current connection setup also uses Google and Twilio STUN services to establish connections; those services receive network information such as your IP address, rather than board content.

Removing a collaborator restricts future access through Pboard and Drive permissions. It cannot erase content that person has already downloaded, copied, or saved elsewhere. Share only content you intend the recipients to access.

## Retention and deletion

Local information remains in your browser profile until you delete it or clear Pboard's local storage. Moving a card to Trash keeps it available until you permanently delete it or empty Trash. Synchronization can retain deletion markers to prevent deleted content from returning. Older local migration or recovery copies and cached images may remain until the extension's stored data is cleared.

When connected, Pboard attempts to propagate supported deletions to Drive. A deletion can remain pending while you are offline or when Google requests fail. Only owners can delete shared project content; removing another person's shared board from your project list does not delete their board. Deletion does not erase copies held by collaborators or in independent backups.

To remove all Pboard information, clear its extension storage and local databases using your browser's controls, and separately remove Pboard's Drive files and application data through Google's storage controls. Uninstalling Pboard does not delete data already stored in Google Drive.

Disconnecting Drive clears the extension's local authorization state or cached token and attempts to revoke Google authorization. It does not delete local boards or existing Drive data. You can also revoke access in your [Google Account connections](https://myaccount.google.com/connections). Revoking authorization stops future authorized access; it does not delete previously stored data.

Google and any recipients of shared content apply their own retention practices to information they hold.

## Security and other services

Pboard uses HTTPS for Google API requests and encrypted WebRTC data channels for live board transfers. Collaboration content is encrypted in transit (WebRTC DTLS); ordinary STUN/ICE connection setup traffic is not. When a board owner has pinned a security authority, live peers additionally authenticate with owner-approved device keys and receiving clients verify permissions, mutations and snapshots by signature; boards without a pinned authority (including ordinary account sync of project order) do not have peer authentication. Snapshots stored through Google Drive remain readable by Google — signatures provide integrity and origin verification, not additional confidentiality. Local storage is protected by your browser and device controls; Pboard does not add a separate password or encryption layer to its local databases. Protect access to your device and Google account.

Google handles authentication, Drive storage, and related service requests under [Google's Privacy Policy](https://policies.google.com/privacy). Browser vendors, extension stores, websites you visit, and services you contact handle information under their own policies. This policy covers the Pboard extension; any future Pboard website with additional data processing will need disclosures for that processing.

## Your choices and privacy requests

You can use Pboard locally, choose what to capture, edit or delete your content, control sharing permissions for boards you own, disconnect Drive, revoke Google authorization, and clear stored data. You can copy board text through Pboard's clipboard controls.

For privacy questions or requests to exercise applicable data protection rights, contact [stefanogozzi@gmail.com](mailto:stefanogozzi@gmail.com). Because the publisher does not host your boards, it generally cannot retrieve or erase data held only on your device, in your Google account, or by collaborators. Do not send board content or credentials unless needed for a support request you choose to make.

## Changes to this policy

Updates will be published with a revised date. If Pboard introduces a new use of Google user data, users will be notified and asked for consent before that new use begins, as required by Google's policies.
