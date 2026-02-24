# Battery Modes

Hara Hachi Bu controls your laptop's charging threshold — the maximum percentage the battery charges to. Three modes are provided, each optimised for a different use case.

## The Modes

| Mode              | Charge Range | Optimised For                        |
| ----------------- | ------------ | ------------------------------------ |
| **Full Capacity** | 95–100%      | Maximum runtime when you need it     |
| **Balanced**      | 75–80%       | Good runtime with improved longevity |
| **Max Lifespan**  | 55–60%       | Maximum battery longevity            |

These ranges are defaults. You can adjust the exact percentages in [Preferences → Thresholds](../preferences.md#thresholds).

## Why It Matters

### The Science

Lithium-ion batteries degrade faster when kept at high charge levels. Limiting the maximum charge — even slightly — can dramatically extend battery lifespan.

Data from [Battery University](https://batteryuniversity.com/article/bu-808-how-to-prolong-lithium-based-batteries):

| Peak Charge Voltage | Approx. Capacity | Cycle Life       |
| ------------------- | ---------------- | ---------------- |
| 4.20 V (100%)       | Full             | 300–500 cycles   |
| 4.10 V (~75%)       | ~85%             | 600–1,000 cycles |
| 4.00 V (~60%)       | ~75%             | 850–1,500 cycles |

Every 0.10 V reduction in peak charge voltage roughly doubles cycle life.

**Depth of discharge** matters too: cycling 100% of capacity yields ~300 cycles (NMC chemistry), while cycling only 40% yields ~1,000 cycles.

**Storage** has a similar effect. A battery stored at 40% charge and 25°C retains 96% capacity after one year. At full charge and the same temperature, only 80% remains. At 40°C and full charge, capacity drops to 65%.

### Environmental Impact

Battery manufacturing produces 54–115 kg CO₂-eq per kWh of capacity, depending on chemistry and sourcing ([Nature Communications, 2024](https://www.nature.com/articles/s41467-024-54634-y)). Around 80% of a notebook's total lifetime greenhouse gas emissions come from manufacturing, not use ([TCO Certified](https://tcocertified.com/news/using-a-notebook-computer-for-three-more-years-can-cut-emissions-in-half/)).

Extending a laptop from 3 to 6 years of service roughly halves its annualized carbon footprint.

Globally, 62 million tonnes of e-waste were generated in 2022, with less than a quarter (22.3%) properly collected and recycled — leaving an estimated US $62 billion in recoverable materials unaccounted for ([UN Global E-Waste Monitor, 2024](https://ewastemonitor.info/the-global-e-waste-monitor-2024/)).

### Economic Impact

Laptop battery replacements cost $50–200 when available, but a degraded battery often prompts full laptop replacement ($300–850+). Charging within the 40–80% range can extend usable battery life from ~300–500 cycles (~2 years of daily cycling) to ~1,000–1,500+ cycles (~4–5 years).

## How to Use the Modes

**Use Max Lifespan** when you're working at a desk plugged in — you don't need more than 60% capacity to get through the day if AC is always available.

**Use Full Capacity** before traveling — you want maximum runtime when you're away from a power outlet.

**Use Balanced** as a default middle ground that protects the battery without sacrificing too much runtime.

Or better yet: let the **Docked** and **Travel** profiles handle the switching automatically based on whether an external display is connected or you're on battery. See [Profiles](profiles.md) and [Auto-Switch Rules](rules.md).

For one-off needs (a day trip, a long flight), use [Boost Charge](profiles.md#boost-charge) to temporarily charge to 100% and have it revert automatically.

## Hardware Requirements

Battery mode control requires your laptop to expose the standard Linux sysfs interface at `/sys/class/power_supply/BAT0/charge_control_end_threshold`. Most ThinkPads, Framework laptops, and many ASUS models support this. See [Hardware Compatibility](../hardware/compatibility.md) for details.
