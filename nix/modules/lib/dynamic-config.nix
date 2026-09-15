# A key emitted as `@dynamic:<value>` tells the service to keep using <value> until an instance
# admin sets an override in the dashboard, and to fall back to it again when the override is cleared.
{ lib }:

{
  dashboardManagedOption = keys: lib.mkOption {
    type = lib.types.listOf (lib.types.enum keys);
    default = [ ];
    example = lib.take 1 keys;
    description = ''
      Environment keys handed to the instance dashboard, under Instance settings > Configuration.
      A listed key keeps the value configured here until an instance admin overrides it, and
      returns to it when the override is cleared. Keys this service can hand over:
      ${lib.concatStringsSep ", " keys}.
    '';
  };

  delegateToDashboard = managed: environment:
    environment // lib.genAttrs managed (key:
      if environment ? ${key} then "@dynamic:${environment.${key}}" else "@dynamic");
}
