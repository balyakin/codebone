;; Imports
(import_statement) @import

;; Function declarations
(function_declaration
  name: (identifier) @function.name
) @function.def

;; Arrow functions assigned to variables
(lexical_declaration
  (variable_declarator
    name: (identifier) @function.name
    value: (arrow_function)
  )
) @function.def

;; Class declarations
(class_declaration
  name: (type_identifier) @class.name
) @class.def

;; Method definitions inside classes
(method_definition
  name: (property_identifier) @method.name
) @method.def

;; Properties inside classes
(public_field_definition
  name: (property_identifier) @property.name
) @property.def

;; Interfaces, type aliases, enums
(interface_declaration
  name: (type_identifier) @interface.name
) @interface.def

(type_alias_declaration
  name: (type_identifier) @type.name
) @type.def

(enum_declaration
  name: (identifier) @enum.name
) @enum.def

(export_statement) @export

(call_expression
  function: [
    (identifier) @reference
    (member_expression property: (property_identifier) @reference)
  ])
