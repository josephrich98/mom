# Intermittent drought reduces soil carbon retention in temperate grasslands through altered microbial turnover

## Abstract

Temperate grasslands store a large share of terrestrial soil carbon, yet the consequences of intermittent drought for that store remain poorly constrained. We conducted a three-year rainfall manipulation across 412 plots arranged as 206 plot pairs at the Halvorsen Prairie Reserve, comparing ambient rainfall with intermittent drought imposed by automated shelters. After quality control, 389 plots contributed to the final analysis. Net carbon retention declined from 182 g C m-2 yr-1 under ambient rainfall to 141 g C m-2 yr-1 under intermittent drought. Microbial respiration pulses following rewetting released an additional 57 g C m-2 yr-1, while root inputs fell by 96 g C m-2 yr-1. Structural equation models indicated that microbial turnover, rather than reduced plant productivity alone, explained most of the decline in retention. Plots with deeper clay horizons were partly buffered against these losses, retaining 230 g C m-2 yr-1 under ambient rainfall and showing a proportionally smaller decline when rainfall was withheld. These results suggest that intermittent drought can weaken the grassland carbon sink even when total annual precipitation is unchanged, because the timing of water delivery reorganizes belowground carbon flows. Incorporating rewetting pulses and texture-dependent buffering into land surface models would improve projections of soil carbon under future precipitation regimes, and management that preserves fine-textured subsoils may offer a modest but practical means of protecting existing carbon stocks across the temperate grassland biome.

## Introduction

Soils hold more carbon than the atmosphere and terrestrial vegetation combined [1]. Grasslands account for a disproportionate share of that pool because their dense, fine root systems deliver carbon directly into mineral horizons [2]. Climate projections indicate that total precipitation in many temperate regions will change only modestly, while its delivery will become more episodic [3].

Previous experiments have mostly examined chronic reductions in rainfall [4]. Far fewer have examined intermittent drought, in which dry periods alternate with large rewetting events while annual totals stay constant [5]. Rewetting is known to trigger a sharp pulse of microbial respiration [6], but whether these pulses accumulate into a lasting loss of soil carbon is unresolved. The answer matters because land surface models generally treat soil moisture as a slowly varying control on decomposition [7].

We asked three questions. First, does intermittent drought reduce net carbon retention relative to ambient rainfall when annual totals are held constant? Second, are losses driven primarily by reduced plant inputs or by altered microbial turnover? Third, does soil texture buffer these effects?

## Methods

### Study site

The study was conducted at the Halvorsen Prairie Reserve, a mesic tallgrass remnant on silty clay loam. Mean annual precipitation at the reserve is 842 mm and mean annual temperature is 11.4 degrees Celsius. The vegetation is dominated by warm-season perennial grasses and has been managed by prescribed fire on a three-year rotation for several decades.

### Experimental design

We established 412 plots of 4 m2 arranged as 206 plot pairs, blocked by slope position and clay depth. One plot in each pair received ambient rainfall, and the other received intermittent drought imposed by automated retractable shelters that intercepted all rainfall for 21-day periods. Intercepted water was stored and applied to the same plot as a single rewetting event at the end of each period, so that annual water inputs did not differ between treatments [8]. Treatments ran for three consecutive growing seasons.

Sensors in each plot logged volumetric water content at hourly intervals. Plots with sensor failures lasting longer than two weeks, or with shelter malfunctions during a drought period, were excluded, which left 389 plots for analysis.

### Measurements

Soil respiration was measured weekly with an automated chamber array, and at 30-minute intervals for 72 hours after each rewetting event. Root inputs were estimated from sequential ingrowth cores. Net carbon retention was calculated as the difference between total carbon inputs and heterotrophic respiration, following established partitioning approaches [9]. Microbial biomass and community composition were assessed from phospholipid fatty acid profiles at the end of each growing season [10].

### Statistical analysis

Treatment effects were estimated with linear mixed models that included plot pair as a random intercept and year as a repeated factor. Structural equation models were used to separate the contributions of plant inputs and microbial turnover to net retention [11]. All analyses were conducted in R, and two-sided tests were interpreted at a significance threshold of 0.05.

## Results

Across the 389 plots retained after quality control, intermittent drought reduced net carbon retention from 182 g C m-2 yr-1 to 141 g C m-2 yr-1 (Table 1). The effect was consistent across all three years and did not diminish over time.

Rewetting events produced large and rapid respiration pulses. Pulse emissions added 57 g C m-2 yr-1 to heterotrophic respiration under intermittent drought. Root inputs were lower by 96 g C m-2 yr-1, a substantial reduction that was only partly offset by reduced respiration during the dry periods themselves.

Structural equation models attributed the majority of the decline in retention to microbial turnover, and the direct path from root inputs to retention was comparatively weak. Plots with deep clay horizons retained 230 g C m-2 yr-1 under ambient rainfall and showed a proportionally smaller response to intermittent drought than did shallow-clay plots.

Table 1. Net carbon retention by treatment (n = 412 plots enrolled; 389 analyzed).

| Treatment | Net retention |
|---|---|
| Ambient rainfall | 182 g C m-2 yr-1 |
| Intermittent drought | 141 g C m-2 yr-1 |
| Ambient rainfall, deep clay | 230 g C m-2 yr-1 |

## Discussion

Our results show that intermittent drought can reduce soil carbon retention even when annual precipitation is unchanged. This finding contrasts with the common assumption that annual water balance is the primary control on grassland carbon cycling [4]. The persistence of the effect across three years argues against a transient response to the onset of treatment.

The dominance of microbial turnover in the structural models is consistent with laboratory evidence that repeated wetting and drying accelerates the processing of otherwise protected organic matter [6]. Rewetting pulses appear to be a principal route by which carbon leaves these soils, which implies that models lacking a rewetting response will underestimate losses [7].

Texture-dependent buffering offers a plausible mechanism for spatial variation in the response. Fine-textured horizons retain water longer and can protect organic matter through mineral association [12]. Reduced carbon losses in deep-clay plots suggest that the vulnerability of grassland carbon stocks is likely to vary across landscapes in predictable ways.

Field crews reported no change in the frequency of burrowing animals between treatments. Shelter frames cast little shade because they remained retracted except during rainfall.

## Conclusions

Intermittent drought weakened the carbon sink of a temperate grassland by reorganizing belowground carbon flows. The timing of rainfall deserves equal standing with its total amount in projections of soil carbon.

## References

[1] Ainsley R, Tomescu D. Global soil carbon stocks revisited. Glob Biogeochem Cycles. 2017.
[2] Brandt H, Mwangi P. Root-derived carbon in grassland mineral soils. Ecology. 2018.
[3] Castellano M, Ito K. Precipitation intermittency in a warming climate. Nat Clim Change. 2020.
[4] Delacroix S, Fernandez L. Chronic drought effects on grassland carbon. J Ecol. 2015.
[5] Eriksen T, Novak J. Rewetting dynamics in episodic rainfall experiments. Oecologia. 2019.
[6] Farouk A, Lindqvist E. Respiration pulses after drying and rewetting. Soil Biol Biochem. 2016.
[7] Gupta V, Harlan B. Soil moisture controls in land surface models. J Adv Model Earth Syst. 2021.
[8] Hoffmann C, Oyelaran F. Rainfall manipulation with automated shelters. Methods Ecol Evol. 2014.
[9] Okafor N, Petrov A. Partitioning heterotrophic respiration in field soils. Geoderma. 2021.
[10] Quintero J, Sato M. Phospholipid profiling of grassland soil communities. Appl Soil Ecol. 2013.
[11] Reinholt G, Vasquez E. Structural equation modeling in ecosystem science. Ecosphere. 2018.
[12] Stavros I, Yilmaz O. Mineral protection of organic matter in clay soils. Biogeochemistry. 2022.
