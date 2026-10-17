---
id: integrations
title: What Watchdog integrates with
summary: Supported external services — FeiShu, Slack, Telegram, Discord, Google, Jira / Confluence, GitHub, GitLab — and what's not supported.
---
At a glance, Watchdog integrates with:

- **FeiShu (Lark)** — DM-style bot notifications and interaction (Settings > IM bots). See the FeiShu bot topic. (FeiShu is no longer a sign-in method for Watchdog itself.)
- **Slack** — Settings > IM bots (the "Watchdog" tab) manages workspace connections. With a compatible server, **Slack Communications on This Device** enables agent tools (search / read history / post as the authorized user) independently on multiple devices; Bot chats and tasks still go to a single receiving device. Enabling communications does not change that receiver.
- **Telegram** — link your Telegram account to the official Watchdog bot under Settings > IM bots (the "Watchdog" tab). No bot token is required. Telegram tasks use the same local projects and Watchdog sessions as Slack, while keeping channel-specific project and model preferences separate.
- **Discord** — a Discord bot you bring yourself (your own Discord App + bot token) under Settings > IM bots.
- **Google** — Gmail / Calendar / Drive / Sheets, via the Filo Google plugin (Plugins > Filo Google).
- **GitHub / GitLab** — via the Watchdog GitHub and Watchdog GitLab plugins (Plugins).
- **The coding agents** — Claude Code and Codex can reach pay-per-token models through **Watchdog AI** in Settings > Model Providers.

**Not supported:**

- There is no built-in Microsoft Teams integration. For chat notifications, use the FeiShu, Slack, Telegram, or Discord bot.
- There's no native Linear integration as a first-party feature — those would have to come via an MCP a user installs themselves.

**Notes:**

- Most of these connections are accessed by the agents through their tools (plugins / MCPs), not directly by the desktop app. Connecting on the plugin detail page is what gives its tools access to your account.
