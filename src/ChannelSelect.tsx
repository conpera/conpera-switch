import { useState } from 'react';
import ConperaSelect from './ConperaSelect';

// Classify explicit internal channels; "不降智测试" is a public channel label.
export const isAdvancedChannel = (name: string) => /内部|实验|试验|沙盒|内测|^测试|\b(test(?:ing)?|internal|experimental|sandbox|staging)\b/i.test(name);

type Props = { label: string; value: string; channels: { id: string; name: string }[]; disabled: boolean; onChange: (channel: string) => void };

export default function ChannelSelect({ label, value, channels, disabled, onChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const unique = [...new Map(channels.map(channel => [channel.id, channel])).values()];
  const advanced = unique.filter(channel => isAdvancedChannel(channel.name));
  // Keep an already selected advanced channel visible without changing it.
  const regular = unique.filter(channel => !isAdvancedChannel(channel.name) || channel.id === value);
  return <div className="channel-picker">
    <ConperaSelect className="channel-select" label={`${label} 渠道`} value={value} disabled={disabled}
      options={regular.map(channel => ({ value: channel.id, label: channel.name }))} onChange={onChange}/>
    {advanced.length > 0 && <div className="advanced-channels">
      <button type="button" className="advanced-toggle" aria-expanded={expanded} aria-label={`${label} 高级选项`}
        disabled={disabled} onClick={() => setExpanded(!expanded)}>高级选项 <span aria-hidden="true">{expanded ? '−' : '+'}</span></button>
      {expanded && <div className="advanced-channel-options">
        <span className="eyebrow">内部与测试渠道</span>
        <ConperaSelect label={`${label} 内部测试渠道`} value={advanced.some(channel => channel.id === value) ? value : ''} disabled={disabled}
          options={advanced.map(channel => ({ value: channel.id, label: channel.name }))}
          onChange={channel => { onChange(channel); setExpanded(false); }}/>
      </div>}
    </div>}
  </div>;
}
