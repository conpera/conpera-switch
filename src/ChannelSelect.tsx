import { useState } from 'react';
import ConperaSelect from './ConperaSelect';

// The API currently supplies channel names. Classify the channel, never the
// user's key name: a key called "test" can still belong to a normal channel.
export const isAdvancedChannel = (name: string) => /内部|测试|实验|试验|沙盒|内测|\b(test(?:ing)?|internal|experimental|sandbox|staging)\b/i.test(name);

type Props = { label: string; value: string; channels: string[]; disabled: boolean; onChange: (channel: string) => void };

export default function ChannelSelect({ label, value, channels, disabled, onChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const unique = [...new Set(channels)];
  const advanced = unique.filter(isAdvancedChannel);
  // Keep an already selected advanced channel visible without changing it.
  const regular = unique.filter(channel => !isAdvancedChannel(channel) || channel === value);
  return <div className="channel-picker">
    <ConperaSelect className="channel-select" label={`${label} 渠道`} value={value} disabled={disabled}
      options={regular.map(channel => ({ value: channel, label: channel }))} onChange={onChange}/>
    {advanced.length > 0 && <div className="advanced-channels">
      <button type="button" className="advanced-toggle" aria-expanded={expanded} aria-label={`${label} 高级选项`}
        disabled={disabled} onClick={() => setExpanded(!expanded)}>高级选项 <span aria-hidden="true">{expanded ? '−' : '+'}</span></button>
      {expanded && <div className="advanced-channel-options">
        <span className="eyebrow">内部与测试渠道</span>
        <ConperaSelect label={`${label} 内部测试渠道`} value={advanced.includes(value) ? value : ''} disabled={disabled}
          options={advanced.map(channel => ({ value: channel, label: channel }))}
          onChange={channel => { onChange(channel); setExpanded(false); }}/>
      </div>}
    </div>}
  </div>;
}
