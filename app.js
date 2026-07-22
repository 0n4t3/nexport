import { SimplePool, nip19 } from "https://esm.sh/nostr-tools@2.10.4?bundle";
import JSZip from "https://esm.sh/jszip@3.10.1";

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const pubkeyInput = el("pubkey-input");
const relayInput = el("relay-input");
const loadBtn = el("load-btn");
const pdfBtn = el("pdf-btn");
const zipBtn = el("zip-btn");
const htmlBtn = el("html-btn");
const statusEl = el("status");
const progressEl = el("progress");
const bookletEl = el("booklet");
const optReactions = el("opt-reactions");
const optReplies = el("opt-replies");
const optParents = el("opt-parents");
const optTheme = el("opt-theme");
const themeStatus = el("theme-status");
const dateFromInput = el("date-from");
const dateToInput = el("date-to");
const imgWidthInput = el("img-width");
const imgQualityInput = el("img-quality");
const imgQualityVal = el("img-quality-val");

imgQualityInput.addEventListener("input", () => {
  imgQualityVal.textContent = imgQualityInput.value;
});

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://nostr.wine",
  "wss://relay.snort.social",
];

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i;
const URL_RE = /(https?:\/\/[^\s"'<>]+)/gi;
// NIP-21/NIP-19 event references embedded in note text: nostr:nevent1…, nostr:note1…, or bare bech32.
const QUOTE_RE = /(?:nostr:)?\b(n(?:event|ote)1[02-9ac-hj-np-z]{10,})/gi;

let pool = null;
let state = {
  pubkey: null,
  profile: null,
  relays: [],
  rawEventsByGroup: {}, // for zip export: { "own-posts": [...], "parents": [...], "reactions": [...], "replies": [...] }
  theme: null, // active ditto.pub profile theme (kind 16767): { background, text, primary, title }
};

function setStatus(msg) {
  statusEl.textContent = msg;
}
function appendStatus(msg) {
  statusEl.textContent = (statusEl.textContent ? statusEl.textContent + "\n" : "") + msg;
}
function setProgress(pct) {
  if (pct == null) {
    progressEl.hidden = true;
    return;
  }
  progressEl.hidden = false;
  progressEl.value = pct;
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------
async function resolvePubkey(raw) {
  const input = raw.trim();
  if (!input) throw new Error("Enter an npub, nprofile, hex pubkey, or NIP-05 address.");

  if (/^[0-9a-f]{64}$/i.test(input)) return { pubkey: input.toLowerCase(), hintRelays: [] };

  if (input.startsWith("npub1")) {
    const decoded = nip19.decode(input);
    return { pubkey: decoded.data, hintRelays: [] };
  }

  if (input.startsWith("nprofile1")) {
    const decoded = nip19.decode(input);
    return { pubkey: decoded.data.pubkey, hintRelays: decoded.data.relays || [] };
  }

  if (input.includes("@")) {
    const [name, domain] = input.split("@");
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`NIP-05 lookup failed (${res.status}) for ${input}`);
    const json = await res.json();
    const pubkey = json.names && json.names[name];
    if (!pubkey) throw new Error(`NIP-05 address ${input} did not resolve to a pubkey.`);
    const hintRelays = (json.relays && json.relays[pubkey]) || [];
    return { pubkey, hintRelays };
  }

  throw new Error("Unrecognized identity format.");
}

// ---------------------------------------------------------------------------
// Relay discovery
// ---------------------------------------------------------------------------
async function discoverRelays(pubkey, seedRelays) {
  const relayList = await pool.get(seedRelays, { kinds: [10002], authors: [pubkey] });
  if (relayList) {
    const relays = relayList.tags
      .filter((t) => t[0] === "r")
      .map((t) => t[1])
      .filter(Boolean);
    if (relays.length) return relays;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
async function fetchProfile(pubkey, relays) {
  return pool.get(relays, { kinds: [0], authors: [pubkey] });
}

// ditto.pub profile theme — kind 16767 is a replaceable event holding the user's
// currently active theme. It carries three `c` color tags tagged by role
// (background / text / primary), plus optional font/background tags we don't use.
// Returns null unless all three roles resolve to valid #rrggbb colors.
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
async function fetchActiveTheme(pubkey, relays) {
  const ev = await pool.get(relays, { kinds: [16767], authors: [pubkey] });
  if (!ev) return null;
  const colors = {};
  for (const t of ev.tags) {
    if (t[0] === "c" && HEX_COLOR_RE.test(t[1] || "") && t[2]) colors[t[2]] = t[1].toLowerCase();
  }
  if (!colors.background || !colors.text || !colors.primary) return null;
  const titleTag = ev.tags.find((t) => t[0] === "title" && t[1]);
  return {
    background: colors.background,
    text: colors.text,
    primary: colors.primary,
    title: titleTag ? titleTag[1] : "",
  };
}

// The booklet's colors are all derived from three CSS custom properties, so a
// theme is applied (or cleared) purely by overriding them on #booklet. This
// affects the live preview, the printed PDF, and the HTML export in one shot.
function applyBookletTheme(theme) {
  const props = { "--booklet-bg": "background", "--booklet-text": "text", "--booklet-primary": "primary" };
  for (const [cssVar, key] of Object.entries(props)) {
    if (theme) bookletEl.style.setProperty(cssVar, theme[key]);
    else bookletEl.style.removeProperty(cssVar);
  }
}

// Reflects the detected theme into the option checkbox + status line, and
// applies it to the booklet when found. Called after a load completes.
function updateThemeControl() {
  if (state.theme) {
    optTheme.disabled = false;
    optTheme.checked = true;
    themeStatus.hidden = false;
    themeStatus.textContent = state.theme.title
      ? `Found ditto.pub theme “${state.theme.title}”.`
      : "Found a ditto.pub theme for this profile.";
    applyBookletTheme(state.theme);
  } else {
    optTheme.disabled = true;
    optTheme.checked = false;
    themeStatus.hidden = false;
    themeStatus.textContent = "No ditto.pub theme found — using the default look.";
    applyBookletTheme(null);
  }
}

optTheme.addEventListener("change", () => {
  applyBookletTheme(optTheme.checked && state.theme ? state.theme : null);
});

// since/until are optional unix-second bounds (inclusive) from the date-range
// option. Relays apply them server-side, so an empty range fetches everything.
async function fetchAllAuthoredNotes(pubkey, relays, { since = null, until = null } = {}) {
  const seen = new Map();
  let cursor = until != null ? until : Math.floor(Date.now() / 1000) + 60;
  const pageSize = 500;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const filter = { kinds: [1], authors: [pubkey], until: cursor, limit: pageSize };
    if (since != null) filter.since = since;
    const batch = await pool.querySync(relays, filter);
    if (!batch.length) break;
    let oldest = cursor;
    let newCount = 0;
    for (const ev of batch) {
      if (!seen.has(ev.id)) {
        seen.set(ev.id, ev);
        newCount++;
      }
      if (ev.created_at < oldest) oldest = ev.created_at;
    }
    appendStatus(`Fetched ${seen.size} posts so far…`);
    if (batch.length < pageSize || newCount === 0) break;
    cursor = oldest - 1;
    // Paged back past the start of the requested range — nothing older matters.
    if (since != null && cursor < since) break;
  }
  return [...seen.values()];
}

// Reads the two date inputs into inclusive unix-second bounds. Dates are
// interpreted in the user's local timezone: the "from" day starts at 00:00:00
// and the "to" day extends through 23:59:59 so both endpoints are included.
function parseDateRange() {
  const fromVal = dateFromInput.value;
  const toVal = dateToInput.value;
  const since = fromVal ? Math.floor(new Date(`${fromVal}T00:00:00`).getTime() / 1000) : null;
  const until = toVal ? Math.floor(new Date(`${toVal}T23:59:59.999`).getTime() / 1000) : null;
  if (since != null && until != null && since > until) {
    throw new Error("Date range is invalid: the start date is after the end date.");
  }
  return { since, until };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchByIds(ids, relays, kinds) {
  const results = new Map();
  for (const batch of chunk(ids, 200)) {
    const events = await pool.querySync(relays, { kinds, ids: batch });
    for (const ev of events) results.set(ev.id, ev);
  }
  return results;
}

async function fetchReferencing(ids, relays, kinds) {
  const results = [];
  for (const batch of chunk(ids, 100)) {
    const events = await pool.querySync(relays, { kinds, "#e": batch });
    results.push(...events);
  }
  return results;
}

// Profile metadata (kind 0) for a set of pubkeys, newest event wins per pubkey.
async function fetchProfiles(pubkeys, relays) {
  const newest = new Map();
  for (const batch of chunk(pubkeys, 100)) {
    const events = await pool.querySync(relays, { kinds: [0], authors: batch });
    for (const ev of events) {
      const prev = newest.get(ev.pubkey);
      if (!prev || prev.created_at < ev.created_at) newest.set(ev.pubkey, ev);
    }
  }
  const metaByPubkey = new Map();
  for (const [pk, ev] of newest) metaByPubkey.set(pk, safeJson(ev.content));
  return metaByPubkey;
}

// Quoted/embedded events: nostr:nevent1…/note1… tokens in the content, plus
// NIP-18 "q" tags. token is null for q-tag-only refs (nothing to strip from text).
function extractQuoteRefs(ev) {
  const refs = [];
  const seen = new Set();
  for (const m of ev.content.matchAll(QUOTE_RE)) {
    try {
      const decoded = nip19.decode(m[1]);
      const id = decoded.type === "note" ? decoded.data : decoded.data.id;
      if (!seen.has(id)) {
        seen.add(id);
        refs.push({ token: m[0], id });
      }
    } catch {
      // not valid bech32 — leave the text untouched
    }
  }
  for (const t of ev.tags) {
    if (t[0] === "q" && /^[0-9a-f]{64}$/i.test(t[1] || "") && !seen.has(t[1])) {
      seen.add(t[1]);
      refs.push({ token: null, id: t[1] });
    }
  }
  return refs;
}

// NIP-10: find the immediate parent event id a note is replying to.
function getParentId(ev) {
  const eTags = ev.tags.filter((t) => t[0] === "e");
  if (!eTags.length) return null;
  const reply = eTags.find((t) => t[3] === "reply");
  if (reply) return reply[1];
  const root = eTags.find((t) => t[3] === "root");
  if (root && eTags.length === 1) return root[1];
  // deprecated positional scheme: last e tag is the one being replied to
  return eTags[eTags.length - 1][1];
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------
function extractImageUrls(ev) {
  const urls = new Set();
  for (const t of ev.tags) {
    if (t[0] === "imeta") {
      const urlPart = t.find((p) => typeof p === "string" && p.startsWith("url "));
      if (urlPart) urls.add(urlPart.slice(4));
    }
    if (t[0] === "image" && t[1]) urls.add(t[1]);
  }
  const matches = ev.content.match(URL_RE) || [];
  for (const m of matches) {
    if (IMAGE_EXT_RE.test(m)) urls.add(m);
  }
  return [...urls];
}

function stripImageUrlsFromText(content, imageUrls) {
  let text = content;
  for (const u of imageUrls) text = text.split(u).join("");
  return text.trim();
}

async function downscaleImage(url, maxWidth, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timeout = setTimeout(() => resolve(url), 8000);
    img.onload = () => {
      clearTimeout(timeout);
      try {
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", Number(quality));
        resolve(dataUrl);
      } catch (e) {
        // Canvas got tainted by a CORS-restrictive image host — fall back to the original URL.
        resolve(url);
      }
    };
    img.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function monthKey(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
}

// Calendar span between two timestamps as whole years + leftover months (0–11).
// The day-of-month check drops a not-yet-complete final month so the total never
// rounds up past the real elapsed time.
function spanYearsMonths(startTs, endTs) {
  const start = new Date(startTs * 1000);
  const end = new Date(endTs * 1000);
  let years = end.getFullYear() - start.getFullYear();
  let months = end.getMonth() - start.getMonth();
  if (end.getDate() < start.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years: Math.max(0, years), months: Math.max(0, months) };
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function linkify(text) {
  return escapeHtml(text).replace(URL_RE, (m) => `<a href="${m}">${m}</a>`);
}

// Profiles and quoted events for the booklet currently being rendered; set by renderBooklet.
let renderCtx = { profiles: new Map(), quotedById: new Map() };

function buildPostElement(ev, { isParent = false, isQuote = false, extraNote = "" } = {}) {
  const imageUrls = extractImageUrls(ev);
  const quoteRefs = extractQuoteRefs(ev);
  let textOnly = stripImageUrlsFromText(ev.content, imageUrls);
  for (const ref of quoteRefs) {
    if (ref.token) textOnly = textOnly.split(ref.token).join("").trim();
  }

  const wrap = document.createElement("div");
  wrap.className = "post" + (isParent ? " parent-post" : "");

  const authorMeta = renderCtx.profiles.get(ev.pubkey) || {};
  const authorName = displayNameFor(authorMeta);

  const header = document.createElement("div");
  header.className = "post-header";
  header.appendChild(buildAvatarEl(authorMeta.picture, authorName, "post-avatar"));
  const nameEl = document.createElement("span");
  nameEl.className = "post-author";
  nameEl.textContent = authorName;
  header.appendChild(nameEl);
  const meta = document.createElement("span");
  meta.className = "post-meta";
  meta.textContent = `· ${fmtDate(ev.created_at)}${isParent ? " · in reply to this post" : ""}`;
  header.appendChild(meta);
  wrap.appendChild(header);

  const content = document.createElement("div");
  content.className = "post-content";
  content.innerHTML = linkify(textOnly);
  wrap.appendChild(content);

  if (imageUrls.length) {
    const imagesWrap = document.createElement("div");
    imagesWrap.className = "post-images";
    for (const url of imageUrls) {
      const img = document.createElement("img");
      img.dataset.srcOriginal = url;
      img.alt = "";
      imagesWrap.appendChild(img);
    }
    wrap.appendChild(imagesWrap);
  }

  // Embedded/quoted posts render as nested quote boxes (one level deep —
  // quotes inside quotes are stripped from the text but not expanded).
  if (!isQuote) {
    for (const ref of quoteRefs) {
      const box = document.createElement("div");
      box.className = "embedded-quote";
      const quoted = renderCtx.quotedById.get(ref.id);
      if (quoted) {
        box.appendChild(buildPostElement(quoted, { isQuote: true }));
      } else {
        box.classList.add("quote-missing");
        box.textContent = "Quoted post (not found on the selected relays)";
      }
      wrap.appendChild(box);
    }
  }

  if (extraNote) {
    const extra = document.createElement("div");
    extra.className = "post-extra";
    extra.textContent = extraNote;
    wrap.appendChild(extra);
  }

  return wrap;
}

function displayNameFor(meta) {
  return meta.display_name || meta.name || "Anonymous";
}

function initialsFor(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function buildAvatarEl(pictureUrl, name, sizeClass) {
  if (pictureUrl) {
    const img = document.createElement("img");
    if (sizeClass) img.className = sizeClass;
    img.dataset.srcOriginal = pictureUrl;
    img.alt = name;
    return img;
  }
  const fallback = document.createElement("div");
  fallback.className = "avatar-fallback" + (sizeClass ? ` ${sizeClass}` : "");
  fallback.textContent = initialsFor(name);
  return fallback;
}

async function renderBooklet({ profile, pubkey, notes, parentsById, reactionsByPost, repliesByPost, quotedById, profilesByPubkey, options }) {
  bookletEl.innerHTML = "";
  renderCtx = { profiles: profilesByPubkey || new Map(), quotedById: quotedById || new Map() };

  const meta = profile ? safeJson(profile.content) : {};
  const name = displayNameFor(meta);
  const npub = nip19.npubEncode(pubkey);

  // Running header, repeats on every printed page via position:fixed.
  const printHeader = document.createElement("div");
  printHeader.className = "print-header";
  printHeader.appendChild(buildAvatarEl(meta.picture, name));
  const printHeaderName = document.createElement("span");
  printHeaderName.textContent = `${name} · Nostr Post History`;
  printHeader.appendChild(printHeaderName);
  bookletEl.appendChild(printHeader);

  // Cover page
  const cover = document.createElement("div");
  cover.className = "booklet-page cover-page";
  cover.appendChild(buildAvatarEl(meta.picture, name, "avatar"));
  const h1 = document.createElement("h1");
  h1.textContent = name;
  cover.appendChild(h1);
  if (meta.nip05) {
    const nip05El = document.createElement("div");
    nip05El.className = "nip05";
    nip05El.textContent = meta.nip05;
    cover.appendChild(nip05El);
  }
  const npubEl = document.createElement("div");
  npubEl.className = "npub";
  npubEl.textContent = npub;
  cover.appendChild(npubEl);
  if (meta.about) {
    const about = document.createElement("div");
    about.className = "about";
    about.textContent = meta.about;
    cover.appendChild(about);
  }

  const stats = document.createElement("div");
  stats.className = "stats";
  // Span from the first to the last post, broken into whole years plus the
  // remaining months (0–11) so the two tiles read as one duration — e.g.
  // "4 years, 3 months" rather than the old "4 years / 33 months" mismatch.
  const span = notes.length
    ? spanYearsMonths(notes[0].created_at, notes[notes.length - 1].created_at)
    : { years: 0, months: 0 };
  const statEntries = [["Posts", notes.length], ["Years", span.years], ["Months", span.months]];
  if (notes.length) {
    const fmtDay = (ts) =>
      new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    statEntries.push([
      "Date range",
      `${fmtDay(notes[0].created_at)} – ${fmtDay(notes[notes.length - 1].created_at)}`,
    ]);
  }
  for (const [label, value] of statEntries) {
    const statEl = document.createElement("div");
    const valEl = document.createElement("span");
    valEl.className = "stat-value";
    valEl.textContent = value;
    const labelEl = document.createElement("span");
    labelEl.className = "stat-label";
    labelEl.textContent = label;
    statEl.appendChild(valEl);
    statEl.appendChild(labelEl);
    stats.appendChild(statEl);
  }
  cover.appendChild(stats);

  const genMeta = document.createElement("div");
  genMeta.className = "meta";
  genMeta.textContent = `Generated ${new Date().toLocaleDateString()}`;
  cover.appendChild(genMeta);
  bookletEl.appendChild(cover);

  // Group by month
  const groups = new Map();
  for (const ev of notes) {
    const key = monthKey(ev.created_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  const sortedKeys = [...groups.keys()].sort();

  // TOC
  const toc = document.createElement("div");
  toc.className = "booklet-page toc";
  const tocH2 = document.createElement("h2");
  tocH2.textContent = "Table of Contents";
  toc.appendChild(tocH2);
  const ul = document.createElement("ul");
  for (const key of sortedKeys) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${monthLabel(key)}</span><span>${groups.get(key).length} posts</span>`;
    ul.appendChild(li);
  }
  toc.appendChild(ul);
  bookletEl.appendChild(toc);

  if (!sortedKeys.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No posts found on the selected relays.";
    bookletEl.appendChild(empty);
  }

  for (const key of sortedKeys) {
    const section = document.createElement("div");
    section.className = "booklet-page month-section";
    const heading = document.createElement("div");
    heading.className = "month-heading";
    heading.textContent = monthLabel(key);
    section.appendChild(heading);

    const monthNotes = groups.get(key).sort((a, b) => a.created_at - b.created_at);
    for (const ev of monthNotes) {
      // The parent post, its "reply below" connector, and the reply itself are
      // wrapped as one unit so a page break never lands between them.
      const group = document.createElement("div");
      group.className = "post-group";

      if (options.showParents) {
        const parentId = getParentId(ev);
        if (parentId && parentsById.has(parentId)) {
          const parentEl = buildPostElement(parentsById.get(parentId), { isParent: true });
          group.appendChild(parentEl);
          const connector = document.createElement("div");
          connector.className = "reply-connector";
          connector.textContent = "↳ reply below";
          group.appendChild(connector);
        }
      }

      const reactions = reactionsByPost.get(ev.id) || [];
      const replies = repliesByPost.get(ev.id) || [];
      let extraNote = "";
      const bits = [];
      if (options.includeReactions && reactions.length) bits.push(`${reactions.length} reaction${reactions.length === 1 ? "" : "s"}`);
      if (options.includeReplies && replies.length) bits.push(`${replies.length} repl${replies.length === 1 ? "y" : "ies"}`);
      if (bits.length) extraNote = bits.join(" · ");

      const postEl = buildPostElement(ev, { extraNote });
      group.appendChild(postEl);

      // Replies live inside the same post-group as the post they answer, so a
      // page break can't separate a post from its replies.
      if (options.includeReplies && replies.length) {
        const repliesBlock = document.createElement("div");
        repliesBlock.className = "replies-block";
        for (const r of replies.sort((a, b) => a.created_at - b.created_at)) {
          repliesBlock.appendChild(buildPostElement(r));
        }
        group.appendChild(repliesBlock);
      }
      section.appendChild(group);
    }
    bookletEl.appendChild(section);
  }

  await hydrateImages();
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

async function hydrateImages() {
  const maxWidth = Number(imgWidthInput.value) || 480;
  const quality = Number(imgQualityInput.value) || 0.6;
  const imgs = [...bookletEl.querySelectorAll("img[data-src-original]")];
  setStatus(`Downscaling ${imgs.length} image(s)…`);
  let done = 0;
  await Promise.all(
    imgs.map(async (img) => {
      const url = img.dataset.srcOriginal;
      const result = await downscaleImage(url, maxWidth, quality);
      if (result) img.src = result;
      else img.remove();
      done++;
      setProgress(Math.round((done / Math.max(imgs.length, 1)) * 100));
    })
  );
  setProgress(null);
  setStatus("Ready.");
}

// ---------------------------------------------------------------------------
// Main load flow
// ---------------------------------------------------------------------------
loadBtn.addEventListener("click", async () => {
  loadBtn.disabled = true;
  pdfBtn.disabled = true;
  zipBtn.disabled = true;
  htmlBtn.disabled = true;
  optTheme.disabled = true;
  optTheme.checked = false;
  themeStatus.hidden = true;
  state.theme = null;
  applyBookletTheme(null);
  bookletEl.innerHTML = "";
  setStatus("Resolving identity…");
  setProgress(null);

  try {
    // Validate the date range up front so a bad range fails before any fetching.
    const dateRange = parseDateRange();

    pool = new SimplePool();

    const { pubkey, hintRelays } = await resolvePubkey(pubkeyInput.value);
    state.pubkey = pubkey;

    const manualRelays = relayInput.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const seedRelays = [...new Set([...manualRelays, ...hintRelays, ...DEFAULT_RELAYS])];

    setStatus("Looking up relay list (NIP-65)…");
    const discovered = await discoverRelays(pubkey, seedRelays);
    const relays = [...new Set([...manualRelays, ...discovered, ...(manualRelays.length ? [] : DEFAULT_RELAYS)])];
    if (!relays.length) relays.push(...DEFAULT_RELAYS);
    state.relays = relays;
    relayInput.value = relays.join("\n");

    setStatus(`Using ${relays.length} relay(s):\n${relays.join("\n")}`);

    appendStatus("Fetching profile metadata…");
    const profile = await fetchProfile(pubkey, relays);
    state.profile = profile;

    appendStatus("Checking for a ditto.pub profile theme…");
    state.theme = await fetchActiveTheme(pubkey, relays);

    if (dateRange.since != null || dateRange.until != null) {
      const fmtBound = (ts) => new Date(ts * 1000).toLocaleDateString();
      const fromLabel = dateRange.since != null ? fmtBound(dateRange.since) : "the beginning";
      const toLabel = dateRange.until != null ? fmtBound(dateRange.until) : "now";
      appendStatus(`Fetching posts from ${fromLabel} to ${toLabel}…`);
    } else {
      appendStatus("Fetching posts…");
    }
    const notes = await fetchAllAuthoredNotes(pubkey, relays, dateRange);
    notes.sort((a, b) => a.created_at - b.created_at);

    const options = {
      includeReactions: optReactions.checked,
      includeReplies: optReplies.checked,
      showParents: optParents.checked,
    };

    let parentsById = new Map();
    if (options.showParents) {
      const parentIds = [...new Set(notes.map(getParentId).filter(Boolean))];
      if (parentIds.length) {
        appendStatus(`Fetching ${parentIds.length} parent post(s)…`);
        parentsById = await fetchByIds(parentIds, relays, [1]);
      }
    }

    const noteIds = notes.map((n) => n.id);
    let reactionsByPost = new Map();
    if (options.includeReactions && noteIds.length) {
      appendStatus("Fetching reactions…");
      const reactions = await fetchReferencing(noteIds, relays, [7]);
      reactionsByPost = groupByReferencedPost(reactions, noteIds);
    }

    let repliesByPost = new Map();
    if (options.includeReplies && noteIds.length) {
      appendStatus("Fetching replies from others…");
      const replies = await fetchReferencing(noteIds, relays, [1]);
      const filtered = replies.filter((r) => r.pubkey !== pubkey);
      repliesByPost = groupByReferencedPost(filtered, noteIds);
    }

    // Quoted/embedded posts (nostr:nevent…/note… tokens and q tags) in anything we render.
    const allRendered = [...notes, ...parentsById.values(), ...[...repliesByPost.values()].flat()];
    const quoteIds = [...new Set(allRendered.flatMap((ev) => extractQuoteRefs(ev).map((r) => r.id)))];
    let quotedById = new Map();
    if (quoteIds.length) {
      appendStatus(`Fetching ${quoteIds.length} quoted post(s)…`);
      quotedById = await fetchByIds(quoteIds, relays, [1]);
    }

    appendStatus("Fetching author profiles…");
    const authorPubkeys = [...new Set([pubkey, ...allRendered.map((ev) => ev.pubkey), ...[...quotedById.values()].map((ev) => ev.pubkey)])];
    const profilesByPubkey = await fetchProfiles(authorPubkeys, relays);
    if (profile && !profilesByPubkey.has(pubkey)) profilesByPubkey.set(pubkey, safeJson(profile.content));

    state.rawEventsByGroup = {
      "own-posts": notes,
      parents: [...parentsById.values()],
      reactions: [...reactionsByPost.values()].flat(),
      replies: [...repliesByPost.values()].flat(),
      quoted: [...quotedById.values()],
    };

    appendStatus("Rendering booklet…");
    await renderBooklet({ profile, pubkey, notes, parentsById, reactionsByPost, repliesByPost, quotedById, profilesByPubkey, options });

    // Reflect the detected ditto.pub theme into the option + apply it to the booklet.
    updateThemeControl();

    pdfBtn.disabled = false;
    zipBtn.disabled = false;
    htmlBtn.disabled = false;
    setStatus(`Done. Loaded ${notes.length} posts across ${new Set(notes.map((n) => monthKey(n.created_at))).size} month(s).`);
  } catch (err) {
    console.error(err);
    appendStatus(`Error: ${err.message || err}`);
  } finally {
    loadBtn.disabled = false;
    setProgress(null);
    if (pool) pool.close(state.relays);
  }
});

function groupByReferencedPost(events, validPostIds) {
  const validSet = new Set(validPostIds);
  const map = new Map();
  for (const ev of events) {
    const eTags = ev.tags.filter((t) => t[0] === "e" && validSet.has(t[1]));
    for (const t of eTags) {
      if (!map.has(t[1])) map.set(t[1], []);
      map.get(t[1]).push(ev);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------
// PDF generation uses the browser's native print-to-PDF (window.print) rather
// than a canvas-rasterization library: it's far more reliable on booklets with
// thousands of posts, keeps text selectable/searchable, and needs no CDN
// dependency. print CSS in style.css hides the app chrome and forces page
// breaks between the cover, TOC, and each month.
pdfBtn.addEventListener("click", () => {
  setStatus('Opening the print dialog — choose "Save as PDF" as the destination.');
  window.print();
});

// ---------------------------------------------------------------------------
// Single-file HTML export
// ---------------------------------------------------------------------------
// Serializes the already-rendered booklet — the same DOM the PDF prints from —
// into one standalone .html document: the booklet markup with the stylesheet
// inlined and images already embedded as data URLs by hydrateImages(). The
// result opens with no server, network, or relay connection.
async function collectStyleCss() {
  // Prefer fetching the stylesheet source so we capture it verbatim.
  try {
    const res = await fetch("style.css");
    if (res.ok) return await res.text();
  } catch {
    // Opened from file:// where fetch is blocked — reconstruct from the sheets.
  }
  let css = "";
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) css += `${rule.cssText}\n`;
    } catch {
      // Inaccessible (e.g. cross-origin) stylesheet — skip it.
    }
  }
  return css;
}

htmlBtn.addEventListener("click", async () => {
  htmlBtn.disabled = true;
  setStatus("Building single-file HTML export…");
  try {
    const meta = state.profile ? safeJson(state.profile.content) : {};
    const title = `${displayNameFor(meta)} — Nostr Post History`;

    const baseCss = await collectStyleCss();
    // Standalone overrides: on screen #booklet is a scroll box inside the app;
    // as a full page it should flow freely and sit on a page-like backdrop.
    const overrideCss = `
html, body { margin: 0; background: #e9e9ee; }
#booklet {
  max-width: 820px;
  margin: 2rem auto;
  max-height: none;
  overflow: visible;
  box-shadow: 0 2px 24px rgba(0, 0, 0, 0.18);
}
@media print { #booklet { max-width: none; margin: 0; box-shadow: none; } }`;

    const doc =
      `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
${baseCss}
${overrideCss}
</style>
</head>
<body>
<div id="booklet"${bookletEl.getAttribute("style") ? ` style="${escapeHtml(bookletEl.getAttribute("style"))}"` : ""}>${bookletEl.innerHTML}</div>
</body>
</html>`;

    const blob = new Blob([doc], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nostr-history-${state.pubkey || "user"}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("HTML file downloaded.");
  } catch (err) {
    console.error(err);
    appendStatus(`HTML export error: ${err.message || err}`);
  } finally {
    htmlBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// JSON zip export
// ---------------------------------------------------------------------------
// Each event is written to its own file containing a single canonical Nostr
// event object — the 7 fields defined by NIP-01 (id, pubkey, created_at, kind,
// tags, content, sig) and nothing else. That's exactly the object a client
// wraps in ["EVENT", <event>] to publish, so any file here can be re-uploaded
// to a relay verbatim. nostr-tools may attach transport-only extras (e.g. a
// [SymbolTable] marker); canonicalEvent strips those so the JSON re-verifies.
function canonicalEvent(ev) {
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags,
    content: ev.content,
    sig: ev.sig,
  };
}

// A UTC date prefix keeps files chronologically sortable in a file browser; the
// full event id guarantees uniqueness (two notes can share a second).
function eventFileName(ev) {
  const day = new Date(ev.created_at * 1000).toISOString().slice(0, 10);
  return `${day}-${ev.id}.json`;
}

zipBtn.addEventListener("click", async () => {
  zipBtn.disabled = true;
  setStatus("Building zip of raw events…");
  try {
    const zip = new JSZip();
    let fileCount = 0;

    // The profile (kind 0) is itself a signed event — export it as a standalone
    // event file too, so it can be re-published like any other note.
    if (state.profile) {
      zip.folder("profile").file(eventFileName(state.profile), JSON.stringify(canonicalEvent(state.profile), null, 2));
      fileCount++;
    }

    for (const [group, events] of Object.entries(state.rawEventsByGroup)) {
      if (!events.length) continue;
      const folder = zip.folder(group);
      const usedNames = new Set();
      for (const ev of events) {
        // Guard against duplicate ids within a group producing a colliding name.
        let name = eventFileName(ev);
        while (usedNames.has(name)) name = name.replace(/\.json$/, `-${usedNames.size}.json`);
        usedNames.add(name);
        folder.file(name, JSON.stringify(canonicalEvent(ev), null, 2));
        fileCount++;
      }
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nostr-events-${state.pubkey || "user"}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(`Zip downloaded — ${fileCount} event file(s), one event per file.`);
  } catch (err) {
    console.error(err);
    appendStatus(`Zip export error: ${err.message || err}`);
  } finally {
    zipBtn.disabled = false;
  }
});
