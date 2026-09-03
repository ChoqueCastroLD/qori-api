-- Add Flow (Peru/Yape gateway) as a top-up method.
ALTER TYPE "TopUpMethod" ADD VALUE IF NOT EXISTS 'FLOW';
