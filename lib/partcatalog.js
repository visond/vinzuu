'use strict';
/**
 * Every part type a shop can sell, grouped the way parts catalogues group them (TecDoc, Toyota and
 * Hyundai/Kia parts books, PartZone's maintenance menu): service parts first, then each system of
 * the car. This is real reference data, not demo data, so it exists in a clean database too.
 *
 * Format of each line:   Name | keywords
 * A "*" before the name marks a standard-size part (battery, oil, bulbs, tyres): it is sold by
 * size or specification, not by part number, so it is offered for every car.
 * "keywords" are the everyday words people type, so "brake noise" finds the brake pads.
 *
 * Add new part types at the end of their group. Never rename one: listings, bookings and part
 * numbers point at the name.
 */
const GROUPS = `
# Service parts
Oil Filter | oil,filter,service,maintenance,oil change
Air Filter | air,filter,service,dust,power,engine air
Cabin Air Filter | ac filter,pollen,cabin,smell,air conditioner,aircon,dust inside
Fuel Filter | fuel,filter,diesel,petrol,service,hesitation
Spark Plug | spark,plug,misfire,starting,rough idle,tune up,ignition
Glow Plug | glow,diesel,cold start,starting,smoke
Drive Belt | belt,fan belt,serpentine,squeal,alternator belt
Timing Belt Kit | timing,belt,cambelt,service,tensioner
Timing Chain Kit | timing,chain,rattle,noise,tensioner
Transmission Filter | gearbox,transmission,filter,automatic,service
*Engine Oil | engine oil,oil,service,lubricant,oil change,5w30,10w40
*Wiper Blade | wiper,wipers,rain,windscreen,windshield,streaks

# Brakes
Front Brake Pad | brake,brakes,braking,squeal,squealing,noise,grinding,stopping,pedal
Rear Brake Pad | brake,brakes,rear brake,noise
Front Brake Disc | brake,disc,rotor,vibration,shaking,grinding
Rear Brake Disc | brake,disc,rotor,rear,vibration
Rear Brake Shoe | brake,shoe,drum,rear,handbrake
Rear Brake Drum | brake,drum,rear,noise
Brake Caliper | caliper,brake,sticking,pulling,leak
Brake Master Cylinder | brake,master cylinder,soft pedal,spongy
Brake Hose | brake,hose,pipe,leak,fluid
ABS Sensor | abs,sensor,warning light,wheel speed
Handbrake Cable | handbrake,parking brake,cable,hand brake

# Engine
Engine Mount | mount,engine mount,vibration,shaking,knock
Valve Cover Gasket | gasket,valve cover,rocker,oil leak
Cylinder Head Gasket | head gasket,overheating,white smoke,coolant loss
Oil Pan | oil pan,sump,leak
Oil Pump | oil pump,oil pressure,warning light
Crankshaft Oil Seal | seal,oil seal,crankshaft,leak
Piston Ring Set | piston,rings,smoke,oil burning,compression
Camshaft Position Sensor | sensor,camshaft,check engine,starting
Crankshaft Position Sensor | sensor,crankshaft,stalling,no start
Throttle Body | throttle,idle,stalling,acceleration
Turbocharger | turbo,boost,power,smoke,whistle
Intake Manifold Gasket | intake,manifold,gasket,vacuum leak
Exhaust Manifold Gasket | exhaust,manifold,gasket,ticking,leak
PCV Valve | pcv,valve,breather,oil
Engine Assembly | engine,motor,complete engine,used engine

# Cooling
Radiator | radiator,overheating,cooling,leak
Radiator Cap | radiator cap,overheating,coolant
Water Pump | water pump,coolant,overheating,leak
Thermostat | thermostat,overheating,temperature,heater cold
Radiator Fan | fan,cooling fan,overheating,traffic
Radiator Hose | hose,radiator hose,coolant leak
Coolant Reservoir | coolant tank,expansion tank,reservoir,bottle
Intercooler | intercooler,turbo,diesel,power
*Coolant | coolant,antifreeze,radiator water,overheating

# Fuel and ignition
Ignition Coil | coil,ignition,misfire,rough idle,check engine
Fuel Pump | fuel pump,no start,stalling,petrol
Fuel Injector | injector,fuel,misfire,smoke,consumption
Oxygen Sensor | oxygen,o2,lambda,sensor,check engine,consumption
Mass Air Flow Sensor | maf,air flow,sensor,check engine,power
Diesel Injection Pump | injection pump,diesel,no start,smoke

# Exhaust
Catalytic Converter | catalytic,converter,exhaust,check engine,smell
Exhaust Muffler | muffler,silencer,exhaust,loud,noise
Exhaust Pipe | exhaust,pipe,loud,leak
Diesel Particulate Filter | dpf,diesel,particulate,filter,smoke

# Suspension and steering
Front Shock Absorber | shock,absorber,strut,suspension,bouncing,bumpy,front
Rear Shock Absorber | shock,absorber,suspension,bouncing,bumpy,rear
Coil Spring | spring,coil,suspension,sagging,low
Leaf Spring | leaf spring,pickup,suspension,load
Strut Mount | strut mount,top mount,knock,suspension
Lower Control Arm | control arm,wishbone,arm,suspension,knock
Upper Control Arm | control arm,upper arm,suspension
Control Arm Bush | bush,bushing,control arm,knock,rubber
Ball Joint | ball joint,knock,clunk,steering,suspension
Stabilizer Link | stabilizer,link,sway bar,anti roll,knock,rattle
Stabilizer Bush | stabilizer,bush,sway bar,squeak
Tie Rod End | tie rod,steering,play,alignment,tyre wear
Inner Tie Rod | tie rod,rack end,steering,play
Steering Rack | steering rack,steering,leak,heavy steering
Power Steering Pump | power steering,pump,heavy steering,whine
Wheel Bearing | bearing,wheel,humming,noise,grinding
Wheel Hub | hub,wheel,bearing

# Transmission and drive
Clutch Kit | clutch,slipping,gear,pedal,manual
Clutch Master Cylinder | clutch,master cylinder,pedal,leak
Clutch Slave Cylinder | clutch,slave cylinder,pedal,leak
Flywheel | flywheel,clutch,vibration,noise
CV Joint | cv joint,clicking,turning,drive shaft,axle
Drive Shaft | drive shaft,axle,cv,vibration
Propeller Shaft | propeller,prop shaft,4x4,vibration
Differential | differential,diff,noise,4x4
Gearbox | gearbox,transmission,gear,automatic,manual
Transfer Case | transfer case,4x4,four wheel drive
*Gear Oil | gear oil,gearbox oil,differential oil,75w90
*Automatic Transmission Fluid | atf,automatic,transmission,gearbox oil

# Electrical
*Battery | battery,start,starting,dead,flat,electrical
Alternator | alternator,charging,battery light,dead battery
Starter Motor | starter,no start,clicking,cranking
Window Regulator | window,regulator,glass,stuck,motor
Power Window Switch | window,switch,button
Door Lock Actuator | lock,central locking,actuator,door
Horn | horn,hooter,beep
Engine Control Unit | ecu,computer,engine control,module
Car Key and Remote | key,remote,fob,smart key,immobiliser
Parking Sensor | parking sensor,reverse sensor,beeping
Fuse Box | fuse,relay,fuse box,electrical
*Brake Fluid | brake fluid,dot3,dot4,brakes,soft pedal

# Lighting
Headlight Assembly | headlight,light,lamp,night,dim
Tail Light | tail light,rear light,brake light,lamp
Fog Light | fog light,fog lamp,front light
Side Indicator | indicator,side repeater,turn signal
*Headlight Bulb | bulb,headlight bulb,h4,h7,led,dim
*Signal and Brake Bulb | bulb,brake light bulb,indicator bulb

# Body
Front Bumper | bumper,accident,crash,body,damage
Rear Bumper | bumper,rear,accident,crash,body
Bonnet | bonnet,hood,accident,body
Front Fender | fender,wing,mudguard,body
Door | door,body,accident,shell
Tailgate | tailgate,boot lid,trunk,rear door
Side Mirror | mirror,wing mirror,side mirror,broken
Front Grille | grille,front,radiator grille
Windscreen | windscreen,windshield,glass,crack
Rear Windscreen | rear glass,back glass,windscreen
Door Glass | door glass,window glass,broken window
Door Handle | door handle,outside handle,inside handle
Mud Flap | mud flap,splash guard

# Air conditioning and heating
AC Compressor | ac,compressor,aircon,not cold,air conditioner
AC Condenser | ac,condenser,aircon,not cold,leak
AC Evaporator | ac,evaporator,aircon,smell
Blower Motor | blower,fan,heater fan,ac fan,no air
Heater Core | heater,heater core,coolant smell

# Interior
Dashboard | dashboard,dash,interior
Steering Wheel | steering wheel,interior
Airbag | airbag,srs,warning light,safety
Seat Belt | seat belt,belt,safety
Interior Mirror | rear view mirror,interior mirror
*Floor Mats | mats,floor mats,carpet

# Wheels and tyres
*Tyre | tyre,tire,tyres,puncture,flat,wheel
Rim | rim,alloy,wheel,steel wheel
*Wheel Nut | wheel nut,lug nut,wheel bolt

# Safety kit
*Fire Extinguisher | fire extinguisher,safety,police check
*Warning Triangle | triangle,warning,safety,police check
*First Aid Kit | first aid,safety,kit
`;

/** Parses GROUPS into [{ name, type, keywords, grp, sort }] in catalogue order. */
function parseCatalog(text = GROUPS) {
  const out = [];
  let grp = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) { grp = line.slice(1).trim(); continue; }
    const [nameRaw, keywords = ''] = line.split('|').map((s) => s.trim());
    const universal = nameRaw.startsWith('*');
    out.push({
      name: universal ? nameRaw.slice(1).trim() : nameRaw,
      type: universal ? 'universal' : 'model_specific',
      keywords, grp, sort: out.length + 1,
    });
  }
  return out;
}

const PART_CATALOG = parseCatalog();

module.exports = { PART_CATALOG, parseCatalog };
