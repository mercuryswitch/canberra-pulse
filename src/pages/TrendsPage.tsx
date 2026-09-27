/**
 * Trends page (2026-09-25) - replaces the old cramped side-panel sparklines
 * with a real, full-page treatment: proper axes, legible scales, room for
 * each chart to actually breathe. Two tabs - the charts themselves, and a
 * "Key observations" tab of presentation-ready takeaways pulled from this
 * same data (see PROJECT_STATUS.md for how each one was verified).
 *
 * Uses Recharts rather than hand-rolled SVG (the old sparklinePoints()
 * approach) specifically because axis ticks, gridlines and tooltips are the
 * whole point of this rebuild - reinventing them by hand was the original
 * problem, not a shortcut worth keeping.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  fetchCongestionLeaderboard,
  fetchHourlyTrends,
  fetchModeComparison,
  fetchRouteLeaderboard,
  type CongestionLeaderboardEntry,
  type HourlyTrendPoint,
  type ModeComparison,
  type RouteLeaderboard,
  type TrendScope,
} from '@/services/trendService';

const GRID_STROKE = 'rgba(255,255,255,0.08)';
const AXIS_STROKE = 'rgba(255,255,255,0.35)';
const AXIS_TICK = { fill: 'rgba(255,255,255,0.55)', fontSize: 12 };
const TOOLTIP_STYLE = {
  background: '#0f172a',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 8,
  fontSize: 12,
  color: '#f1f5f9',
};

function formatHourTick(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' });
}
function formatHourFull(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
/** ~7 evenly-spaced tick timestamps across the data range - a fixed,
 * chosen tick set reads far cleaner than Recharts guessing at density
 * across a series with a couple hundred hourly points. */
function evenTicks(points: HourlyTrendPoint[], count = 7): number[] {
  if (points.length === 0) return [];
  const first = points[0].hourMs;
  const last = points[points.length - 1].hourMs;
  if (first === last) return [first];
  const step = (last - first) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(first + step * i));
}

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}
function ChartCard({ title, subtitle, children }: ChartCardProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 flex flex-col gap-1">
      <div className="font-display text-sm font-semibold text-white/90">{title}</div>
      {subtitle && <div className="text-xs text-white/40 mb-2">{subtitle}</div>}
      <div className="h-72 w-full mt-2">{children}</div>
    </div>
  );
}

const SCOPES: { id: TrendScope; label: string }[] = [
  { id: 'all', label: 'All days' },
  { id: 'weekday', label: 'Weekdays' },
  { id: 'weekend', label: 'Weekends' },
];

interface Observation {
  headline: string;
  stat: string;
  body: string;
}
const OBSERVATIONS: Observation[] = [
  {
    headline: 'Light rail is dramatically more reliable than buses',
    stat: '98% vs 59%',
    body: 'Light rail runs on-time (within 2 minutes) roughly 98% of the time, compared to about 59% for buses. Same city, same network - dedicated right-of-way is the difference, not driver behaviour.',
  },
  {
    headline: 'The busiest routes are the least punctual',
    stat: 'Routes 5, 4, 6',
    body: "The three highest-ridership bus routes rank among the worst for on-time performance. Popularity doesn't buy reliability on this network - if anything, it's the opposite.",
  },
  {
    headline: "Congestion isn't spread across Canberra - it's one interchange",
    stat: '1 hotspot',
    body: 'The worst-performing road segments over the whole capture window cluster almost entirely around Parkes Way / Edinburgh Ave / Vernon Circle / Constitution Ave, next to Civic.',
  },
  {
    headline: 'There is a real commute peak - just not where the live map shows it',
    stat: '8am & 5pm',
    body: "The live congestion \"severity\" score barely moves day to day, but raw delay-above-free-flow shows a clean AM and PM peak on weekdays that's absent on weekends.",
  },
  {
    headline: 'Weekday service runs at roughly double weekend frequency',
    stat: '~2x',
    body: 'Weekday activity holds a high plateau through the day (not just two narrow peaks) with a distinct rise around 3pm, plausibly school traffic. Weekend volume is flatter and lower throughout.',
  },
  {
    headline: 'The network sleeps on a consistent schedule',
    stat: 'Midnight-5am',
    body: 'Activity falls to near-zero every night in the same window, a clean service boundary rather than a data gap - confirmed by checking multiple independent nights.',
  },
  {
    headline: 'Two-plus weeks of fully unattended, automated capture',
    stat: '3 notebooks, 5-min cadence',
    body: 'Three independent Fabric notebooks polling on a schedule, zero manual intervention across the capture window - the platform point, not just a transit one.',
  },
];

export function TrendsPage() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<TrendScope>('all');
  const [tab, setTab] = useState<'trends' | 'observations'>('trends');
  const [hourly, setHourly] = useState<HourlyTrendPoint[]>([]);
  const [modeComparison, setModeComparison] = useState<ModeComparison>({ bus: null, rail: null });
  const [congestionLeaderboard, setCongestionLeaderboard] = useState<CongestionLeaderboardEntry[]>([]);
  const [routeLeaderboard, setRouteLeaderboard] = useState<RouteLeaderboard>({ best: [], worst: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    void Promise.all([
      fetchHourlyTrends(scope, controller.signal),
      fetchModeComparison(scope, controller.signal),
      fetchCongestionLeaderboard(scope, 5, controller.signal),
      fetchRouteLeaderboard(scope, controller.signal),
    ])
      .then(([h, mode, congestion, routes]) => {
        if (cancelled) return;
        setHourly(h);
        setModeComparison(mode);
        setCongestionLeaderboard(congestion);
        setRouteLeaderboard(routes);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [scope, refreshTick]);

  const ticks = evenTicks(hourly);

  const modeChartData = [
    { name: 'Bus', mode: 'bus' as const, onTime: modeComparison.bus?.onTimePct ?? 0, samples: modeComparison.bus?.samples ?? 0 },
    { name: 'Light rail', mode: 'rail' as const, onTime: modeComparison.rail?.onTimePct ?? 0, samples: modeComparison.rail?.samples ?? 0 },
  ];

  const routeChartData = [
    ...routeLeaderboard.best.map((r) => ({ name: `Route ${r.routeId}`, routeId: r.routeId, onTime: r.onTimePct, group: 'best' as const })),
    ...routeLeaderboard.worst
      .slice()
      .reverse()
      .map((r) => ({ name: `Route ${r.routeId}`, routeId: r.routeId, onTime: r.onTimePct, group: 'worst' as const })),
  ];

  // Opacity scaled within this leaderboard's own min/max, not a fixed
  // formula - every entry here is already "the worst 5," so a fixed
  // threshold clamps them all to the same full-opacity color and the
  // gradient says nothing. Relative scaling keeps the worst-of-the-worst
  // visually distinct from the (still bad) fifth-place entry.
  const congestionScores = congestionLeaderboard.map((c) => c.avgScore);
  const congestionMin = Math.min(...congestionScores);
  const congestionMax = Math.max(...congestionScores);
  const congestionRange = congestionMax - congestionMin || 1;
  const congestionChartData = congestionLeaderboard.map((c) => ({
    name: c.name.length > 28 ? `${c.name.slice(0, 27)}…` : c.name,
    fullName: c.name,
    avgSpeedKmh: Math.round(c.avgSpeedKmh),
    opacity: 0.45 + 0.55 * ((c.avgScore - congestionMin) / congestionRange),
  }));

  return (
    <div className="min-h-screen w-full bg-slate-950 text-white font-sans">
      <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-white/10 sticky top-0 bg-slate-950/95 backdrop-blur z-10">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-white/50 hover:text-white/90 text-sm transition-colors">
            ← Back to map
          </Link>
          <div className="font-display text-lg font-semibold tracking-tight">Canberra Pulse — Trends</div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            {SCOPES.map((s) => (
              <button
                key={s.id}
                onClick={() => setScope(s.id)}
                className={`px-3 py-1.5 rounded-lg border text-sm transition-colors ${
                  scope === s.id ? 'border-white/40 bg-white/10 text-white' : 'border-white/10 text-white/50 hover:text-white/80'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={loading}
            className="text-white/50 hover:text-white/90 disabled:opacity-40 transition-colors text-lg"
            title="Refresh"
            aria-label="Refresh"
          >
            ⟳
          </button>
        </div>
      </header>

      <nav className="flex gap-1 px-6 pt-4">
        {(['trends', 'observations'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors border-b-2 ${
              tab === t ? 'border-sky-400 text-white' : 'border-transparent text-white/40 hover:text-white/70'
            }`}
          >
            {t === 'trends' ? '📈 Trends' : '💡 Key observations'}
          </button>
        ))}
      </nav>

      <main className="px-6 pb-16 pt-4">
        {error && <div className="text-red-400 text-sm mb-4">Couldn't load trends: {error}</div>}
        {!loading && !error && hourly.length === 0 && (
          <div className="text-white/40 text-sm">
            No historic data in this scope yet - come back once the capture has accumulated more hours.
          </div>
        )}

        {tab === 'trends' && hourly.length > 0 && (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                <div className="font-display text-sm font-semibold text-white/90 mb-3">
                  Bus vs light rail reliability <span className="text-white/30 font-normal">(click a bar to view on map)</span>
                </div>
                <div className="h-56 w-full">
                  <ResponsiveContainer>
                    <BarChart data={modeChartData} layout="vertical" margin={{ left: 8, right: 24 }}>
                      <CartesianGrid stroke={GRID_STROKE} horizontal={false} />
                      <XAxis
                        type="number"
                        domain={[0, 100]}
                        tickFormatter={(v: number) => `${v}%`}
                        stroke={AXIS_STROKE}
                        tick={AXIS_TICK}
                      />
                      <YAxis type="category" dataKey="name" width={80} stroke={AXIS_STROKE} tick={AXIS_TICK} />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(v: number, _n, p) => [`${v}% on time (${p.payload.samples.toLocaleString()} obs)`, '']}
                      />
                      <Bar
                        dataKey="onTime"
                        radius={[0, 6, 6, 0]}
                        cursor="pointer"
                        onClick={(data) => navigate(`/?mode=${data.payload.mode}`)}
                      >
                        {modeChartData.map((d) => (
                          <Cell key={d.name} fill={d.name === 'Bus' ? '#f59e0b' : '#14b8a6'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                <div className="font-display text-sm font-semibold text-white/90 mb-3">
                  Route on-time leaderboard{' '}
                  <span className="text-white/30 font-normal">(busiest routes, n≥200 - click a bar to view on map)</span>
                </div>
                <div className="h-56 w-full">
                  <ResponsiveContainer>
                    <BarChart data={routeChartData} layout="vertical" margin={{ left: 8, right: 24 }}>
                      <CartesianGrid stroke={GRID_STROKE} horizontal={false} />
                      <XAxis type="number" domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} stroke={AXIS_STROKE} tick={AXIS_TICK} />
                      <YAxis type="category" dataKey="name" width={80} stroke={AXIS_STROKE} tick={AXIS_TICK} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v}% on time`, '']} />
                      <Bar
                        dataKey="onTime"
                        radius={[0, 6, 6, 0]}
                        cursor="pointer"
                        onClick={(data) => navigate(`/?route=${data.payload.routeId}`)}
                      >
                        {routeChartData.map((d) => (
                          <Cell key={d.name} fill={d.group === 'best' ? '#22c55e' : '#ef4444'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {congestionChartData.length > 0 && (
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
                <div className="font-display text-sm font-semibold text-white/90 mb-1">Most congested roads</div>
                <div className="text-xs text-white/40 mb-3">
                  Average speed over the capture window - lower is worse - click a bar to open the congestion overlay
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer>
                    <BarChart data={congestionChartData} layout="vertical" margin={{ left: 8, right: 24 }}>
                      <CartesianGrid stroke={GRID_STROKE} horizontal={false} />
                      <XAxis
                        type="number"
                        unit=" km/h"
                        stroke={AXIS_STROKE}
                        tick={AXIS_TICK}
                      />
                      <YAxis type="category" dataKey="name" width={220} stroke={AXIS_STROKE} tick={{ ...AXIS_TICK, fontSize: 11 }} />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(v: number) => [`${v} km/h avg`, '']}
                        labelFormatter={(_l, p) => (p && p[0] ? p[0].payload.fullName : '')}
                      />
                      <Bar dataKey="avgSpeedKmh" radius={[0, 6, 6, 0]} cursor="pointer" onClick={() => navigate('/?congestion=1')}>
                        {congestionChartData.map((d) => (
                          <Cell key={d.name} fill={`rgba(249, 115, 22, ${d.opacity.toFixed(2)})`} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <ChartCard title="Network median delay, hourly" subtitle="Average minutes late across all matched observations">
              <ResponsiveContainer>
                <LineChart data={hourly} margin={{ left: 4, right: 16, top: 8, bottom: 4 }}>
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis
                    dataKey="hourMs"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    ticks={ticks}
                    tickFormatter={formatHourTick}
                    stroke={AXIS_STROKE}
                    tick={AXIS_TICK}
                  />
                  <YAxis
                    stroke={AXIS_STROKE}
                    tick={AXIS_TICK}
                    tickFormatter={(v: number) => `${v}m`}
                    label={{ value: 'Delay (min)', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.4)', fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(v: number) => formatHourFull(v)}
                    formatter={(v: unknown) => [typeof v === 'number' ? `${v.toFixed(1)} min` : 'no data', 'Delay']}
                  />
                  <Line type="monotone" dataKey="avgDelayMinutes" stroke="#f1f5f9" strokeWidth={2} dot={false} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Congestion, hourly average score" subtitle="0 = free-flowing, higher = more congested">
              <ResponsiveContainer>
                <LineChart data={hourly} margin={{ left: 4, right: 16, top: 8, bottom: 4 }}>
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis
                    dataKey="hourMs"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    ticks={ticks}
                    tickFormatter={formatHourTick}
                    stroke={AXIS_STROKE}
                    tick={AXIS_TICK}
                  />
                  <YAxis
                    stroke={AXIS_STROKE}
                    tick={AXIS_TICK}
                    label={{ value: 'Score', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.4)', fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(v: number) => formatHourFull(v)}
                    formatter={(v: unknown) => [typeof v === 'number' ? v.toFixed(3) : 'no data', 'Score']}
                  />
                  <Line type="monotone" dataKey="avgCongestionScore" stroke="#f97316" strokeWidth={2} dot={false} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Active vehicles, hourly" subtitle="Distinct vehicles observed per hour, all modes">
              <ResponsiveContainer>
                <LineChart data={hourly} margin={{ left: 4, right: 16, top: 8, bottom: 4 }}>
                  <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                  <XAxis
                    dataKey="hourMs"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    ticks={ticks}
                    tickFormatter={formatHourTick}
                    stroke={AXIS_STROKE}
                    tick={AXIS_TICK}
                  />
                  <YAxis
                    stroke={AXIS_STROKE}
                    tick={AXIS_TICK}
                    label={{ value: 'Vehicles', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.4)', fontSize: 12 }}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(v: number) => formatHourFull(v)}
                    formatter={(v: number) => [v, 'Vehicles']}
                  />
                  <Line type="monotone" dataKey="activeVehicles" stroke="#38bdf8" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <div className="text-xs text-white/30 pt-2 border-t border-white/10">
              Server-side hourly aggregates straight from Kusto — scales fine regardless of how much raw data the capture
              accumulates underneath. {hourly.length}h of history shown, from{' '}
              {new Date(hourly[0].hourMs).toLocaleString(undefined, { month: 'short', day: 'numeric' })}.
            </div>
          </div>
        )}

        {tab === 'observations' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-5xl">
            {OBSERVATIONS.map((obs) => (
              <div key={obs.headline} className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 flex flex-col gap-2">
                <div className="text-3xl font-display font-bold text-sky-400">{obs.stat}</div>
                <div className="font-display text-base font-semibold text-white/90">{obs.headline}</div>
                <div className="text-sm text-white/50 leading-relaxed">{obs.body}</div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default TrendsPage;
