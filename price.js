/* Shared pricing clock. DeepSeek's rules are ported from
   deepakness.com/deepseek; Ollama's rules come from ollama.com/pricing. */

const DEFAULT_PROVIDER = "deepseek";
// Keep DeepSeek's UTC switch instants in sync with deepakness.com/deepseek.
const SWITCH_MINUTES = [60, 240, 360, 600];
const PROVIDERS = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    switchMinutes: SWITCH_MINUTES,
    dayBoundaryMinutes: 960, // Midnight in Beijing.
    schedule: "Weekends & CN holidays off-peak · Beijing time",
    url: "https://deepakness.com/deepseek/",
    linkLabel: "Full price clock ↗",
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    switchMinutes: [720, 1080],
    dayBoundaryMinutes: 0, // Weekends follow UTC, not Beijing time.
    schedule: "Peak: Mon–Fri, 12:00–18:00 UTC · weekends off-peak",
    url: "https://ollama.com/pricing",
    linkLabel: "Ollama pricing ↗",
  },
};

function getProvider(id = DEFAULT_PROVIDER) {
  return Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : PROVIDERS[DEFAULT_PROVIDER];
}

// Since 00:00 Beijing time on Sunday August 23, 2026 (16:00 UTC Saturday
// August 22) the split only applies Monday to Friday Beijing time.
const WEEKEND_RULE_START = Date.UTC(2026, 7, 22, 16);

// Chinese public holidays from the State Council's yearly arrangement, as
// Beijing dates. DeepSeek bills them off-peak all day. Add the next year's
// dates once announced (usually November).
const CN_HOLIDAYS = [
  ["2026-09-25", "2026-09-27"], // Mid-Autumn
  ["2026-10-01", "2026-10-07"], // National Day
];

function isBeijingWeekend(date) {
  const beijing = new Date(date.getTime() + 8 * 3600000);
  return beijing.getUTCDay() === 0 || beijing.getUTCDay() === 6;
}

function beijingDateKey(date) {
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

function isBeijingHoliday(date) {
  const key = beijingDateKey(date);
  for (const [from, to] of CN_HOLIDAYS) {
    if (key >= from && key <= to) return true;
  }
  return false;
}

// Each provider applies its own weekend timezone and holiday rules.
function offPeakAllDay(date, provider = DEFAULT_PROVIDER) {
  if (getProvider(provider).id === "ollama") {
    return date.getUTCDay() === 0 || date.getUTCDay() === 6;
  }
  return (
    date.getTime() >= WEEKEND_RULE_START &&
    (isBeijingWeekend(date) || isBeijingHoliday(date))
  );
}

// Which half of the pricing an instant falls in.
function kindAtInstant(date, provider = DEFAULT_PROVIDER) {
  if (offPeakAllDay(date, provider)) return "off";
  const minuteOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();
  const switches = getProvider(provider).switchMinutes;
  for (let i = 0; i < switches.length; i += 2) {
    if (minuteOfDay >= switches[i] && minuteOfDay < switches[i + 1]) {
      return "peak";
    }
  }
  return "off";
}

// A switch minute is a real price change only outside gated weekends/holidays.
function isSwitchInstant(date, provider = DEFAULT_PROVIDER) {
  const minuteOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();
  for (const m of getProvider(provider).switchMinutes) {
    if (minuteOfDay === m) return !offPeakAllDay(date, provider);
  }
  return false;
}

// The next N price changes as absolute instants.
function nextSwitches(now, count, provider = DEFAULT_PROVIDER) {
  const switches = getProvider(provider).switchMinutes;
  const dayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const out = [];
  let day = 0;
  let index = 0;
  while (out.length < count) {
    const instant = dayStart + day * 86400000 + switches[index] * 60000;
    const candidate = new Date(instant);
    if (instant > now.getTime() && isSwitchInstant(candidate, provider)) {
      out.push({ date: candidate, kind: kindAtInstant(candidate, provider) });
    }
    index++;
    if (index >= switches.length) {
      index = 0;
      day++;
    }
  }
  return out;
}

function nextSwitch(now, provider = DEFAULT_PROVIDER) {
  return nextSwitches(now, 1, provider)[0];
}

// Current window plus the instant it ends.
function currentWindow(now, provider = DEFAULT_PROVIDER) {
  const next = nextSwitch(now, provider);
  return {
    kind: kindAtInstant(now, provider),
    nextKind: next.kind,
    end: next.date,
    minuteOfDay: now.getUTCHours() * 60 + now.getUTCMinutes(),
  };
}

// The instant the window you're in began. Walks back up to 21 days to cross
// any weekend + holiday off-peak stretch.
function currentWindowStart(now, provider = DEFAULT_PROVIDER) {
  const dayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  let best = null;
  for (let day = -21; day <= 0; day++) {
    for (const minute of getProvider(provider).switchMinutes) {
      const instant = dayStart + day * 86400000 + minute * 60000;
      const candidate = new Date(instant);
      if (
        instant <= now.getTime() &&
        isSwitchInstant(candidate, provider) &&
        (best === null || instant > best.getTime())
      ) {
        best = candidate;
      }
    }
  }
  return best || new Date(now.getTime() - 86400000);
}

// A list of windows as start/end pairs, opening with the active window.
function windowList(now, count, provider = DEFAULT_PROVIDER) {
  const upcoming = nextSwitches(now, count, provider);
  let start = currentWindowStart(now, provider);
  let kind = kindAtInstant(now, provider);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      start,
      end: upcoming[i].date,
      kind,
      current: i === 0,
    });
    start = upcoming[i].date;
    kind = upcoming[i].kind;
  }
  return out;
}

// Rebuild the 24-hour day bar in display time (offsetMinutes ahead of UTC).
function displaySegments(now, offsetMinutes, provider = DEFAULT_PROVIDER) {
  const displayDate = new Date(now.getTime() + offsetMinutes * 60000);
  const dayStart =
    Date.UTC(displayDate.getUTCFullYear(), displayDate.getUTCMonth(), displayDate.getUTCDate()) -
    offsetMinutes * 60000;

  const boundaries = [0, 1440];
  const config = getProvider(provider);
  for (const m of [...config.switchMinutes, config.dayBoundaryMinutes]) {
    boundaries.push(((m + offsetMinutes) % 1440 + 1440) % 1440);
  }
  boundaries.sort((a, b) => a - b);

  const raw = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end <= start) continue;
    const sample = new Date(dayStart + (start + 0.5) * 60000);
    raw.push({ start, end, kind: kindAtInstant(sample, provider) });
  }

  const merged = [];
  for (const segment of raw) {
    const last = merged[merged.length - 1];
    if (last && last.kind === segment.kind) {
      last.end = segment.end;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}
