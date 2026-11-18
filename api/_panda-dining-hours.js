// Opening hours can prove the venue is open, never that its kitchen serves.
const minuteOfDay = point => Number.isInteger(point?.hour) && point.hour >= 0 && point.hour <= 23
  && Number.isInteger(point.minute ?? 0) && (point.minute ?? 0) >= 0 && (point.minute ?? 0) <= 59
  ? point.hour * 60 + (point.minute ?? 0) : null;
function day(value) {
  if (!value || !Number.isInteger(value.year) || !Number.isInteger(value.month) || !Number.isInteger(value.day)) return null;
  const result = `${value.year}-${String(value.month).padStart(2,'0')}-${String(value.day).padStart(2,'0')}`;
  const instant = Date.parse(result);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0,10) === result ? result : null;
}
export function venueOpenAtRequestedTime(venue, window) {
  if (!window?.date || !window.time) return false;
  const time = window.time.split(':').map(Number);
  const minute = time[0] * 60 + time[1];
  const weekday = new Date(`${window.date}T12:00:00Z`).getUTCDay();
  if (!Number.isFinite(weekday)) return false;
  for (const period of Array.isArray(venue?.openingPeriods) ? venue.openingPeriods : []) {
    const start = minuteOfDay(period?.open), end = minuteOfDay(period?.close);
    if (start === null) continue;
    const openDate = day(period.open?.date), closeDate = day(period.close?.date);
    if (openDate || closeDate) {
      if (!openDate || !closeDate || end === null) continue;
      const position = `${window.date}T${window.time}`;
      const starts = `${openDate}T${String(Math.floor(start/60)).padStart(2,'0')}:${String(start%60).padStart(2,'0')}`;
      const ends = `${closeDate}T${String(Math.floor(end/60)).padStart(2,'0')}:${String(end%60).padStart(2,'0')}`;
      if (position >= starts && position < ends) return true;
      continue;
    }
    if (!period.close && period.open?.day === 0 && start === 0) return true;
    if (!Number.isInteger(period.open?.day) || period.open.day < 0 || period.open.day > 6
      || !Number.isInteger(period.close?.day) || period.close.day < 0 || period.close.day > 6 || end === null) continue;
    const from = period.open.day * 1440 + start;
    let until = period.close.day * 1440 + end;
    if (period.open.day === period.close.day && until <= from) continue;
    if (until < from) until += 7 * 1440;
    const position = weekday * 1440 + minute;
    if ((position >= from && position < until) || (position + 10080 >= from && position + 10080 < until)) return true;
  }
  return false;
}
