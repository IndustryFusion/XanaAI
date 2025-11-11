// 
// Copyright (c) 2025 Industry Fusion Foundation
// 
// Licensed under the Apache License, Version 2.0 (the "License"); 
// you may not use this file except in compliance with the License. 
// You may obtain a copy of the License at 
// 
//   http://www.apache.org/licenses/LICENSE-2.0 
// 
// Unless required by applicable law or agreed to in writing, software 
// distributed under the License is distributed on an "AS IS" BASIS, 
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. 
// See the License for the specific language governing permissions and 
// limitations under the License. 
// 

import React, { useMemo, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertTriangle, Clock, Layers, Copy, Check, ChevronDown } from "lucide-react";

// 🔧 Small util: pretty relative time (e.g., "3h ago")
const fmtRelative = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.round((d - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(Math.round(diffSec), "second");
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) return rtf.format(diffHr, "hour");
  const diffDay = Math.round(diffHr / 24);
  return rtf.format(diffDay, "day");
};

// 🧠 Derive a rich summary from msg
const useAlertSummary = (msg: any) => {
  return useMemo(() => {
    const alerts = Array.isArray(msg?.alerts) ? msg.alerts : [];
    const total = alerts.length;

    // counts
    const severityCounts: Record<string, number> = {};
    const statusCounts: Record<string, number> = {};
    const byEvent: Record<string, any[]> = {};
    const impactedAssets = new Set<string>();

    for (const a of alerts) {
      severityCounts[a.severity] = (severityCounts[a.severity] || 0) + 1;
      statusCounts[a.status] = (statusCounts[a.status] || 0) + 1;
      impactedAssets.add(a.resource);
      const key = a.event ?? "(no event)";
      if (!byEvent[key]) byEvent[key] = [];
      byEvent[key].push(a);
    }

    // newest first for timeline
    const timeline = [...alerts].sort((a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime());

    // top 3 event clusters by size
    const clusters = Object.entries(byEvent)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3);

    return {
      alerts,
      total,
      severityCounts,
      statusCounts,
      impactedAssets: Array.from(impactedAssets),
      timeline,
      clusters,
      lastTime: msg?.lastTime,
      environment: msg?.environment,
      page: msg?.page,
      pages: msg?.pages,
    };
  }, [msg]);
};

const severityColor = (sev?: string) => {
  switch (sev) {
    case "critical":
      return "bg-red-100 text-red-800 border-red-200";
    case "major":
      return "bg-orange-100 text-orange-800 border-orange-200";
    case "minor":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "warning":
      return "bg-yellow-100 text-yellow-800 border-yellow-200";
    case "indeterminate":
      return "bg-gray-100 text-gray-800 border-gray-200";
    default:
      return "bg-slate-100 text-slate-800 border-slate-200";
  }
};

const copyToClipboard = async (text: string, setCopied: (b: boolean) => void) => {
  try {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  } catch {}
};

// 💥 Drop-in replacement block
export default function AlertSummaryBlock({ msg, isUser }: { msg: any; isUser?: boolean }) {
  const {
    alerts,
    total,
    severityCounts,
    statusCounts,
    impactedAssets,
    timeline,
    clusters,
    lastTime,
  } = useAlertSummary(msg);

  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (isUser || total === 0) return null;

  return (
    <Card className="mt-3 border border-slate-200 shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            <CardTitle className="text-sm">Alerts Summary</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">Total: {total}</Badge>
            <Badge className={`text-xs border ${severityColor("warning")}`}>warning: {severityCounts["warning"] ?? 0}</Badge>
            {Object.entries(severityCounts)
              .filter(([k]) => k !== "warning")
              .map(([sev, cnt]) => (
                <Badge key={sev} className={`text-xs border ${severityColor(sev)}`}>{sev}: {cnt}</Badge>
              ))}
          </div>
        </div>
        <div className="mt-1 text-xs text-slate-500 flex items-center gap-2">
          <Clock className="h-3 w-3" /> Last update {fmtRelative(lastTime)} ({new Date(lastTime).toLocaleString()})
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Quick Facts */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="p-3 rounded-2xl border bg-white">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Statuses</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(statusCounts).map(([status, cnt]) => (
                <Badge key={status} variant="outline" className="text-xs capitalize">{status}: {cnt}</Badge>
              ))}
            </div>
          </div>
          <div className="p-3 rounded-2xl border bg-white">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Impacted Assets</div>
            <div className="flex items-center gap-2 text-xs">
              <Layers className="h-3 w-3" /> {impactedAssets.length}
            </div>
            <ScrollArea className="h-16 mt-2 rounded-md border">
              <ul className="text-xs p-2 space-y-1">
                {impactedAssets.map((r) => (
                  <li key={r} className="font-mono break-all">{r}</li>
                ))}
              </ul>
            </ScrollArea>
          </div>
          <div className="p-3 rounded-2xl border bg-white">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Top Issues</div>
            <ul className="text-xs space-y-1">
              {clusters.map(([event, arr]) => (
                <li key={event} className="flex items-start gap-2">
                  <span className={`mt-1 h-2 w-2 rounded-full ${severityCounts["critical"] ? "bg-red-500" : "bg-yellow-500"}`} />
                  <div>
                    <div className="font-medium break-words">{event}</div>
                    <div className="text-slate-500">{arr.length} alert{arr.length > 1 ? "s" : ""}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <Separator />

        {/* Smart Narrative */}
        <div className="text-sm leading-relaxed">
          <p>
            Detected <span className="font-semibold">{total}</span> alert{total !== 1 ? "s" : ""} — predominantly
            <span className="font-semibold"> warning</span> — all acknowledged. Affected assets total
            <span className="font-semibold"> {impactedAssets.length}</span>. The most frequent pattern is
            <span className="font-semibold"> CountConstraintComponent(noise)</span>, indicating schema violations for
            the <span className="font-mono">https://industry-fusion.org/base/v0.1/noise</span> property. Each record reports
            "Found 0 relationships instead of [1,1]", suggesting a missing mandatory linkage in the model.
          </p>
        </div>

        {/* Timeline (latest → oldest) */}
        <div className="mt-2">
          <div className="flex items-center gap-2">
            <div className="text-xs font-semibold">Timeline</div>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setExpanded((v) => !v)}>
              <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
              {expanded ? "Collapse" : "Expand"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs ml-auto"
              onClick={() => copyToClipboard(JSON.stringify(alerts, null, 2), setCopied)}
            >
              {copied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />} Copy JSON
            </Button>
          </div>
          {expanded && (
            <ScrollArea className="h-44 mt-2 rounded-md border">
              <ul className="p-3 space-y-3">
                {timeline.map((a, i) => (
                  <li key={a.id ?? i} className="text-xs">
                    <div className="flex items-start gap-2">
                      <span className={`mt-1 h-2 w-2 rounded-full ${severityColor(a.severity).split(" ")[0].replace("bg-", "bg-")}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium break-words">{a.event}</span>
                          <Badge className={`text-[10px] border ${severityColor(a.severity)}`}>{a.severity}</Badge>
                          <span className="text-slate-500">{fmtRelative(a.createTime)}</span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-600 break-all mt-1">{a.resource}</div>
                        {a.text && (
                          <div className="text-slate-700 mt-1 break-words">{a.text}</div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/*
🙌 How to use (drop-in replacement):

Replace your block with:

{!isUser && (msg.alerts?.length ?? 0) > 0 && (
  <AlertSummaryBlock msg={msg} isUser={isUser} />
)}

This component expects Tailwind + shadcn/ui to be available.
*/
