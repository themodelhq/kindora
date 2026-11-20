import {
  GraduationCap, HeartPulse, Droplets, Sprout, ShieldAlert, Baby, Users, PawPrint, Trophy, Palette, Laptop, Home, type LucideIcon,
} from 'lucide-react';

export const CATEGORY_META: Record<string, { name: string; icon: LucideIcon }> = {
  education: { name: 'Education', icon: GraduationCap },
  health: { name: 'Medical & Health', icon: HeartPulse },
  water: { name: 'Water & Sanitation', icon: Droplets },
  environment: { name: 'Environment', icon: Sprout },
  emergency: { name: 'Emergency Relief', icon: ShieldAlert },
  children: { name: 'Children & Family', icon: Baby },
  community: { name: 'Community', icon: Users },
  animals: { name: 'Animals', icon: PawPrint },
  sports: { name: 'Sports', icon: Trophy },
  arts: { name: 'Arts & Culture', icon: Palette },
  tech: { name: 'Technology Access', icon: Laptop },
  housing: { name: 'Housing', icon: Home },
};
