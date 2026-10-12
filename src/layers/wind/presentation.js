import { formatWindSpeed, WIND_UNITS } from './inspection.js';
import { t } from '../../i18n/index.js';
import { formatQuantity, unitLabel } from '../../ui/unitLabels.js';

/** Reformat a captured sample; changing units never samples the map again. */
export function formatWindReading(reading, units) {
  if (!reading) return null;
  return {
    ...reading,
    units,
    scalarValue:
      reading.scalarKind === 'speed'
        ? formatWindSpeed(reading.speed, units)
        : reading.scalarValue,
    wind: Number.isFinite(reading.speed)
      ? `${formatWindSpeed(reading.speed, units)}${reading.from === 'Calm' ? ' · calm' : ` from ${reading.from}`}`
      : reading.wind,
  };
}

export function windUnitChips(units) {
  return Object.keys(WIND_UNITS).map((value) => ({
    id: `units-${value}`,
    label: unitLabel(value),
    active: units === value,
    params: { units: value },
    title: t('Wind speed units'),
  }));
}

/** formatWindSpeed's value in the active language: "22,0 км/ч". */
function displaySpeed(speed, units) {
  const unit = Object.hasOwn(WIND_UNITS, units) ? units : 'km/h';
  return formatQuantity(speed * WIND_UNITS[unit], unit, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** "1012.4 hPa" / "-3.0 °C" from the English reading, in the active language. */
function displayScalar(reading) {
  if (reading.scalarKind === 'speed' && Number.isFinite(reading.speed))
    return displaySpeed(reading.speed, reading.units);
  const match = /^(-?\d+(?:\.\d+)?) (°C|hPa)$/.exec(reading.scalarValue);
  if (!match) return reading.scalarValue;
  const decimals = match[1].split('.')[1]?.length || 0;
  return formatQuantity(Number(match[1]), match[2], {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** The wind line in the active language; the reading itself stays English. */
function windText(reading) {
  if (!Number.isFinite(reading.speed))
    return reading.wind === 'Aim the map center at Earth'
      ? t('Aim the map center at Earth')
      : reading.wind;
  const speed = displaySpeed(reading.speed, reading.units);
  return reading.from === 'Calm'
    ? `${speed}${t(' · calm')}`
    : `${speed}${t(' from {direction}', { direction: t(reading.from) })}`;
}

/** Portable result block consumed by the WEATHER card. */
export function windReadingResult(reading) {
  const coordinates =
    reading.coordinates === 'No surface reading'
      ? t('No surface reading')
      : reading.coordinates.replace(' · ', ' ');
  return {
    id: 'reading',
    label: t('WIND AT {coordinates}', { coordinates }),
    lines: [
      {
        id: 'wind',
        text: windText(reading),
      },
      {
        id: 'meta',
        text: t('{model} · valid {time}', {
          model: reading.model,
          time: reading.validTime?.replace(/^\d{4}-/, ''),
        }),
      },
      ...(reading.scalarValue
        ? [
            {
              id: 'scalar',
              text: `${t(reading.scalarLabel)} · ${displayScalar(reading)}`,
            },
          ]
        : []),
      { id: 'explanation', text: t(reading.explanation) },
    ],
    clear: { params: { inspect: false } },
  };
}
