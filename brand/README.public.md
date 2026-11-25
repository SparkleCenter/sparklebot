<p align="center">
  <img src="brand/source/sparkle-icon-512.png" alt="Sparklebot" width="120">
</p>

<h1 align="center">Sparklebot</h1>

<p align="center">
  <b>Your own AI chief of staff for Windows, built in Tallinn.</b><br>
  A team of assistants that remember your work, run your routines and bring back finished results:<br>
  on your own PC or in your company's own Azure, with your own AI models.
</p>

<p align="center">
  <a href="https://sparklesolutions.ee">sparklesolutions.ee</a> ·
  Built on <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a> by Nous Research (MIT licence)
</p>

<p align="center">
  <img src="brand/characters/spark.svg" alt="Spark" width="104">
  <img src="brand/characters/scout.svg" alt="Scout" width="104">
  <img src="brand/characters/social.svg" alt="Social" width="104">
  <img src="brand/characters/events.svg" alt="Events" width="104">
  <img src="brand/characters/newbot.svg" alt="A new bot" width="104">
</p>
<p align="center"><sub><b>Meet the Sparks.</b> Spark runs your day. Scout researches. Social writes. Events looks after
your community. And a new one wakes up for every job you add.</sub></p>

---

## Why we made it

Most AI assistants live in someone else's cloud, forget yesterday and wait for you to ask. We wanted the
opposite for ourselves at Sparkle Solutions: an assistant that knows how a Tallinn business-to-business company
works, prepares the Monday briefing before we wake up, gets us ready for meetings and drafts the follow-up, and
never sends anything without a person saying yes.

So we took [Hermes Agent](https://github.com/NousResearch/hermes-agent), an excellent open-source agent by Nous
Research, and made it ours: Sparkle's name and look on the outside, the same proven engine inside. We use it
every day first. What works for us, we set up for our clients.

## What it does

- **A chief of staff and specialists.** One main assistant plus bots for research, writing, events or sales,
  each with its own instructions, tools and memory. They can hand work to each other.
- **Routines that run by themselves.** A Monday market brief, a daily agenda, a Friday review: scheduled,
  written as drafts, waiting for you.
- **Your models, your keys.** Connect it to your own Microsoft Foundry (or another provider you choose). This
  repository holds **no keys**: each person connects their own account.
- **Drafts, not surprises.** Out of the box it asks before it acts. Sending, posting and changing things stay
  with a person.
- **Desktop first, Teams next.** A Windows app today. The same bots in Microsoft Teams is what we are building now.

## Install (Windows 10/11)

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/SparkleCenter/sparklebot/main/scripts/install.ps1 | iex
```

It installs the engine and the Sparklebot app from this repository and puts **Sparklebot** in your Start menu.
The first install takes 20 to 40 minutes and downloads its own tools. This early version is not code-signed
yet, so Windows or your company's IT may ask you to confirm it.

Then open Sparklebot and connect a model: Settings → Models → your provider (for Microsoft Foundry, the
endpoint and model deployment from your own Azure). Nothing is shared with us.

## For companies

Sparklebot is free and open source. What Sparkle Solutions adds, in Estonia and on site:

- set-up in **your own Azure**, with your own models and a spending cap;
- connections to the systems your people already use, read-only first;
- bots and routines built around your real work: a weekly picture of sales, stock and market signals, meeting
  preparation, follow-up drafts;
- training for your team and someone nearby who keeps it useful.

Talk to us: [sparklesolutions.ee](https://sparklesolutions.ee).

## How this repository works

Sparklebot is Hermes Agent plus a small layer in [`brand/`](brand/README.md): names, icons and texts, a few
default settings, Foundry pricing and some measured speed fixes. Every change names the exact Hermes text it
replaces, so it is checked again on each new Hermes version. When Nous publishes one, we take it, re-apply the layer,
check that it still fits, and only then publish it here. The `hermes` command, the `@hermes` handle and all of
Hermes's own documentation stay as they are; see [`README.hermes-agent.md`](README.hermes-agent.md).

## Credits and licence

Sparklebot is built on **Hermes Agent** by **Nous Research**, released under the MIT licence. All credit for the
engine goes to Nous Research and the Hermes contributors. Their copyright notice is kept in [`LICENSE`](LICENSE).
Sparklebot is not affiliated with or endorsed by Nous Research. Sparkle's brand layer is released under the same
MIT licence.

Early version, used by our own team first. Feedback and issues are welcome.
