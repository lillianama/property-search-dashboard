"use client";

import { createContext, useContext } from "react";
import type { PropertyTrack } from "../../lib/track";

export const TrackContext = createContext<PropertyTrack>("house");
export const useTrack = () => useContext(TrackContext);
