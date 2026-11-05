// Weather and moon phase for today's new entry.
//
// The moon phase is worked out here, offline. The weather is the app's only
// network request: one call to wttr.in, made only when a location is set and
// today's entry is first created. If it fails or is slow, the entry simply
// opens without it.

use chrono::{NaiveDate, NaiveTime, TimeZone, Utc};
use serde::Serialize;
use std::time::Duration;

const SYNODIC_MONTH: f64 = 29.530_588_853;
/// A known new moon: 6 January 2000, 18:14 UTC.
const NEW_MOON_EPOCH: i64 = 947_182_440;
const FORMAT: &str = "%l:+%c+%t+💨+%w+🌧️+%p";
const TIMEOUT: Duration = Duration::from_secs(3);
const PHASES: [&str; 8] = [
    "🌑 New moon",
    "🌒 Waxing crescent",
    "🌓 First quarter",
    "🌔 Waxing gibbous",
    "🌕 Full moon",
    "🌖 Waning gibbous",
    "🌗 Last quarter",
    "🌘 Waning crescent",
];

#[derive(Serialize, Default)]
pub struct Extras {
    moon: Option<String>,
    weather: Option<String>,
}

/// Moon phase at midday on `day`, accurate to within about a day.
pub fn moon_phase(day: NaiveDate) -> &'static str {
    let noon = Utc.from_utc_datetime(&day.and_time(NaiveTime::from_hms_opt(12, 0, 0).unwrap()));
    let days = (noon.timestamp() - NEW_MOON_EPOCH) as f64 / 86_400.0;
    let age = days.rem_euclid(SYNODIC_MONTH);
    let index = ((age / SYNODIC_MONTH) * 8.0 + 0.5).floor() as usize % 8;
    PHASES[index]
}

/// A blank location switches the weather off.
pub fn clean_location(raw: &str) -> Result<Option<String>, String> {
    let place = raw.trim();
    if place.is_empty() {
        return Ok(None);
    }
    let ok = place.chars().count() <= 60
        && place.chars().all(|c| c.is_alphanumeric() || " -,.'".contains(c));
    if !ok {
        return Err("Use a place name, e.g. Nantlle or Caernarfon".into());
    }
    Ok(Some(place.to_string()))
}

fn fetch_weather(location: &str) -> Option<String> {
    let url = format!("https://wttr.in/{}?format={FORMAT}", location.replace(' ', "+"));
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).build();
    let body = agent.get(&url).call().ok()?.into_string().ok()?;
    let line = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let looks_right = !line.is_empty()
        && line.len() < 200
        && !line.contains('<')
        && !line.to_lowercase().contains("unknown location");
    looks_right.then_some(line)
}

pub fn extras(day: NaiveDate, location: Option<&str>) -> Extras {
    Extras {
        moon: Some(moon_phase(day).to_string()),
        weather: location.and_then(fetch_weather),
    }
}
