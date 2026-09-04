-- Direct payment origin (off-gateway, manual, no commission).
ALTER TYPE "TopUpMethod" ADD VALUE IF NOT EXISTS 'DIRECTO';
