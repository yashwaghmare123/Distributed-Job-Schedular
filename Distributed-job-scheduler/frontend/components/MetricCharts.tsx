"use client";

import { useState } from "react";
import type { WorkerUtilization } from "@/lib/types";

export type MetricPoint = { label: string; value: number; detail?: string };
export type MetricSeries = { label: string; color: string; points: MetricPoint[] };

export const colors = ["#0e7490", "#b45309", "#047857", "#be123c", "#4338ca", "#7c3aed"];
const chartWidth = 720;
const chartHeight = 280;
const plot = { left: 64, right: 18, top: 24, bottom: 62 };

export function formatDateTime(value: string) { return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
function formatTime(value: string) { return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function EmptyChart({ message }: { message: string }) { return <div className="metric-empty">{message}</div>; }
function ChartFrame({ title, xLabel, yLabel, children, legend }: { title: string; xLabel: string; yLabel: string; children: React.ReactNode; legend?: React.ReactNode }) {
  return <div className="metric-chart-wrap" aria-label={title}><div className="metric-axis-y-label">{yLabel}</div><div className="metric-chart-area"><div className="metric-chart-svg">{children}</div><div className="metric-axis-x-label">{xLabel}</div></div>{legend && <div className="metric-legend">{legend}</div>}</div>;
}
function Legend({ series }: { series: Array<{ label: string; color: string }> }) { return <>{series.map((item) => <span className="metric-legend-item" key={item.label}><i style={{ background: item.color }} />{item.label}</span>)}</>; }

export function LineChart({ title, xLabel = "Time", yLabel = "Value", series, emptyMessage = "No historical data available yet." }: { title: string; xLabel?: string; yLabel?: string; series: MetricSeries[]; emptyMessage?: string }) {
  const [hovered, setHovered] = useState<{ series: MetricSeries; point: MetricPoint; x: number; y: number } | null>(null);
  const visibleSeries = series.filter((item) => item.points.length > 0);
  if (!visibleSeries.length) return <EmptyChart message={emptyMessage} />;
  const allPoints = visibleSeries.flatMap((item) => item.points);
  const timestamps = allPoints.map((point) => new Date(point.label).getTime()).filter(Number.isFinite);
  const minimumTime = Math.min(...timestamps);
  const maximumTime = Math.max(...timestamps);
  const timeSpan = Math.max(maximumTime - minimumTime, 1);
  const max = Math.max(...allPoints.map((point) => point.value), 1);
  const tickValues = [...new Set([0, Math.ceil(max / 2), max])];
  const x = (label: string) => plot.left + ((new Date(label).getTime() - minimumTime) / timeSpan) * (chartWidth - plot.left - plot.right);
  const y = (value: number) => plot.top + (1 - value / max) * (chartHeight - plot.top - plot.bottom);
  const xTicks = [...new Map(allPoints.map((point) => [point.label.slice(0, 13), point.label])).values()].sort().slice(0, 6);
  return <ChartFrame title={title} xLabel={xLabel} yLabel={yLabel} legend={visibleSeries.length > 1 ? <Legend series={visibleSeries} /> : undefined}><svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={title}>
    {tickValues.map((tick) => <g key={tick}><line x1={plot.left} x2={chartWidth - plot.right} y1={y(tick)} y2={y(tick)} className="metric-grid-line" /><text x={plot.left - 10} y={y(tick) + 4} textAnchor="end" className="metric-tick">{tick}</text></g>)}
    <line x1={plot.left} x2={plot.left} y1={plot.top} y2={chartHeight - plot.bottom} className="metric-axis-line" /><line x1={plot.left} x2={chartWidth - plot.right} y1={chartHeight - plot.bottom} y2={chartHeight - plot.bottom} className="metric-axis-line" />
    {xTicks.map((label) => <text key={label} x={x(label)} y={chartHeight - plot.bottom + 25} textAnchor="middle" className="metric-tick">{formatTime(label)}</text>)}
    {visibleSeries.map((item) => <g key={item.label}><polyline points={item.points.map((point) => `${x(point.label)},${y(point.value)}`).join(" ")} fill="none" stroke={item.color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />{item.points.map((point, index) => <circle key={`${item.label}-${point.label}-${index}`} cx={x(point.label)} cy={y(point.value)} r="5" fill={item.color} stroke="white" strokeWidth="2" tabIndex={0} onMouseEnter={() => setHovered({ series: item, point, x: x(point.label), y: y(point.value) })} onFocus={() => setHovered({ series: item, point, x: x(point.label), y: y(point.value) })} aria-label={`${item.label}, ${formatDateTime(point.label)}, ${point.value}`} />)}</g>)}
    {hovered && <g className="metric-tooltip" pointerEvents="none"><rect x={Math.min(Math.max(hovered.x - 90, plot.left), chartWidth - 190)} y={Math.max(hovered.y - (hovered.point.detail ? 82 : 62), 2)} width="172" height={hovered.point.detail ? 70 : 50} rx="4" /><text x={Math.min(Math.max(hovered.x, plot.left + 86), chartWidth - 104)} y={Math.max(hovered.y - (hovered.point.detail ? 61 : 42), 20)} textAnchor="middle">{hovered.series.label}: {hovered.point.value.toLocaleString()}</text><text x={Math.min(Math.max(hovered.x, plot.left + 86), chartWidth - 104)} y={Math.max(hovered.y - (hovered.point.detail ? 44 : 24), 38)} textAnchor="middle">{formatDateTime(hovered.point.label)}</text>{hovered.point.detail && <text x={Math.min(Math.max(hovered.x, plot.left + 86), chartWidth - 104)} y={Math.max(hovered.y - 27, 55)} textAnchor="middle">{hovered.point.detail}</text>}</g>}
  </svg></ChartFrame>;
}

export function MultiSeriesLegend({ series }: { series: Array<{ label: string; color: string }> }) { return <Legend series={series} />; }

export function BarChart({ title, xLabel, yLabel, values, colors: valueColors = colors, emptyMessage = "No data available yet." }: { title: string; xLabel: string; yLabel: string; values: MetricPoint[]; colors?: string[]; emptyMessage?: string }) {
  const [hovered, setHovered] = useState<{ point: MetricPoint; x: number; y: number } | null>(null);
  if (!values.length) return <EmptyChart message={emptyMessage} />;
  const max = Math.max(...values.map((item) => item.value), 1);
  const barWidth = Math.min(86, (chartWidth - plot.left - plot.right) / values.length - 12);
  const y = (value: number) => plot.top + (1 - value / max) * (chartHeight - plot.top - plot.bottom);
  return <ChartFrame title={title} xLabel={xLabel} yLabel={yLabel}><svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={title}>
    {[...new Set([0, Math.ceil(max / 2), max])].map((tick) => <g key={tick}><line x1={plot.left} x2={chartWidth - plot.right} y1={y(tick)} y2={y(tick)} className="metric-grid-line" /><text x={plot.left - 10} y={y(tick) + 4} textAnchor="end" className="metric-tick">{tick}</text></g>)}
    <line x1={plot.left} x2={plot.left} y1={plot.top} y2={chartHeight - plot.bottom} className="metric-axis-line" /><line x1={plot.left} x2={chartWidth - plot.right} y1={chartHeight - plot.bottom} y2={chartHeight - plot.bottom} className="metric-axis-line" />
    {values.map((item, index) => { const center = plot.left + ((index + 0.5) / values.length) * (chartWidth - plot.left - plot.right); return <g key={item.label}><rect x={center - barWidth / 2} y={y(item.value)} width={barWidth} height={Math.max(chartHeight - plot.bottom - y(item.value), 1)} fill={valueColors[index % valueColors.length]} rx="3" tabIndex={0} onMouseEnter={() => setHovered({ point: item, x: center, y: y(item.value) })} onFocus={() => setHovered({ point: item, x: center, y: y(item.value) })} aria-label={`${item.label}, ${item.value}`} /><text x={center} y={y(item.value) - 9} textAnchor="middle" className="metric-value-label">{item.value.toLocaleString()}</text><text x={center} y={chartHeight - plot.bottom + 25} textAnchor="middle" className="metric-tick">{item.label}</text></g>; })}
    {hovered && <g className="metric-tooltip" pointerEvents="none"><rect x={Math.min(Math.max(hovered.x - 82, plot.left), chartWidth - 178)} y={Math.max(hovered.y - 58, 2)} width="160" height="44" rx="4" /><text x={Math.min(Math.max(hovered.x, plot.left + 80), chartWidth - 98)} y={Math.max(hovered.y - 38, 20)} textAnchor="middle">{hovered.point.label}: {hovered.point.value.toLocaleString()}</text><text x={Math.min(Math.max(hovered.x, plot.left + 80), chartWidth - 98)} y={Math.max(hovered.y - 20, 38)} textAnchor="middle">Current value</text></g>}
  </svg></ChartFrame>;
}

export function DurationChart({ values }: { values: MetricPoint[] }) { return <LineChart title="Execution duration over time" xLabel="Execution time" yLabel="Duration (ms)" series={[{ label: "Duration (ms)", color: colors[4], points: values }]} emptyMessage="No execution-duration history available." />; }
export function UtilizationBars({ workers }: { workers: WorkerUtilization[] }) { if (!workers.length) return <EmptyChart message="No project worker activity." />; return <div className="utilization-list">{workers.map((worker) => <div className="utilization-row" key={worker.workerId}><div className="utilization-heading"><strong>{worker.workerName}</strong><span>{Math.round(worker.utilization)}% · Running: {worker.runningJobs} / {worker.concurrency}</span></div><div className="utilization-track"><i style={{ width: `${Math.min(Math.max(worker.utilization, 0), 100)}%` }} /></div></div>)}</div>; }
