/**
 * Time-based greeting in our own words, with the settings display name
 * appended exactly like the reference `greeting()` (ui/index.html:368).
 * The name falls back to Abu — the reference seed default (SEED.user.name).
 */
export function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function HomeGreeting({ hour, name = "Abu" }: { hour: number; name?: string }) {
  return (
    <h1 className="text-center font-serif text-3xl text-foreground">
      {greetingForHour(hour)}, {name}
    </h1>
  );
}
