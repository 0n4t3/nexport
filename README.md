# Nexport
*One of those random one off vibe coded tools you can probably ignore. I have no idea if I'll actually polish the project or maintain it long term, I just had some spare credits to burn after paying for an Claude Code plan for other reasons so I thought I'd try making this.*

![](/screenshot.avif)

Nexport is a simple export tool that exports posts on the Nostr network in both zip and PDF form. Servers and nodes don't last forever regardless of the protocol, and if posts aren't mirrored to new servers as old ones go down eventually content might be lost. The ability to export your posts as a sort of digital diary might be a handy way of archiving your content.

Export options:
* PDF booklet (organized by year and month)
* Raw events (.zip) — one signed Nostr event per file, ready to re-upload to relays
* HTML — the full booklet in a single self-contained file
* Optional [ditto.pub](https://ditto.pub) profile themes applied to the PDF and HTML exports
* Optional date-range limiting

Potential improvements:
* Reposted content support
* Wider NIP support
* Activity Pub Support
* Ability to enable/disable images
