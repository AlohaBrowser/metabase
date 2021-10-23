import MetabaseSettings from "metabase/lib/settings";
import type {
  TemplateTag,
  LocalFieldReference,
  ForeignFieldReference,
  FieldFilter,
} from "metabase-types/types/Query";
import type {
  Parameter,
  ParameterInstance,
  ParameterTarget,
  ParameterValue,
  ParameterValueOrArray,
} from "metabase-types/types/Parameter";
import type { FieldId } from "metabase-types/types/Field";
import type Metadata from "metabase-lib/lib/metadata/Metadata";
import Dimension, {
  FieldDimension,
  TemplateTagDimension,
} from "metabase-lib/lib/Dimension";
import moment from "moment";
import _ from "underscore";
import {
  getParameterType,
  getParameterSubType,
} from "metabase/parameters/utils/parameter-type";
import { getParameterOperatorName } from "metabase/parameters/utils/operators";

const areFieldFilterOperatorsEnabled = () =>
  MetabaseSettings.get("field-filter-operators-enabled?");

// NOTE: this should mirror `template-tag-parameters` in src/metabase/api/embed.clj
export function getTemplateTagParameters(tags: TemplateTag[]): Parameter[] {
  function getTemplateTagType(tag) {
    const { type } = tag;
    if (type === "date") {
      return "date/single";
    } else if (areFieldFilterOperatorsEnabled() && type === "string") {
      return "string/=";
    } else if (areFieldFilterOperatorsEnabled() && type === "number") {
      return "number/=";
    } else {
      return "category";
    }
  }

  return tags
    .filter(
      tag =>
        tag.type != null && (tag["widget-type"] || tag.type !== "dimension"),
    )
    .map(tag => {
      return {
        id: tag.id,
        type: tag["widget-type"] || getTemplateTagType(tag),
        target:
          tag.type === "dimension"
            ? ["dimension", ["template-tag", tag.name]]
            : ["variable", ["template-tag", tag.name]],
        name: tag["display-name"],
        slug: tag.name,
        default: tag.default,
      };
    });
}

function isDimensionTarget(target) {
  return target?.[0] === "dimension";
}

export function getParameterTargetField(
  target: ?ParameterTarget,
  metadata,
  question,
): ?FieldId {
  if (isDimensionTarget(target)) {
    const dimension = Dimension.parseMBQL(
      target[1],
      metadata,
      question.query(),
    );

    return dimension?.field();
  }

  return null;
}

type Deserializer = { testRegex: RegExp, deserialize: DeserializeFn };
type DeserializeFn = (
  match: any[],
  fieldRef: LocalFieldReference | ForeignFieldReference,
) => FieldFilter;

const withTemporalUnit = (fieldRef, unit) => {
  const dimension =
    (fieldRef && FieldDimension.parseMBQLOrWarn(fieldRef)) ||
    new FieldDimension(null);

  return dimension.withTemporalUnit(unit).mbql();
};

const timeParameterValueDeserializers: Deserializer[] = [
  {
    testRegex: /^past([0-9]+)([a-z]+)s(~)?$/,
    deserialize: (matches, fieldRef) =>
      ["time-interval", fieldRef, -parseInt(matches[0]), matches[1]].concat(
        matches[2] ? [{ "include-current": true }] : [],
      ),
  },
  {
    testRegex: /^next([0-9]+)([a-z]+)s(~)?$/,
    deserialize: (matches, fieldRef) =>
      ["time-interval", fieldRef, parseInt(matches[0]), matches[1]].concat(
        matches[2] ? [{ "include-current": true }] : [],
      ),
  },
  {
    testRegex: /^this([a-z]+)$/,
    deserialize: (matches, fieldRef) => [
      "time-interval",
      fieldRef,
      "current",
      matches[0],
    ],
  },
  {
    testRegex: /^~([0-9-T:]+)$/,
    deserialize: (matches, fieldRef) => ["<", fieldRef, matches[0]],
  },
  {
    testRegex: /^([0-9-T:]+)~$/,
    deserialize: (matches, fieldRef) => [">", fieldRef, matches[0]],
  },
  {
    testRegex: /^(\d{4}-\d{2})$/,
    deserialize: (matches, fieldRef) => [
      "=",
      withTemporalUnit(fieldRef, "month"),
      moment(matches[0], "YYYY-MM").format("YYYY-MM-DD"),
    ],
  },
  {
    testRegex: /^(Q\d-\d{4})$/,
    deserialize: (matches, fieldRef) => [
      "=",
      withTemporalUnit(fieldRef, "quarter"),
      moment(matches[0], "[Q]Q-YYYY").format("YYYY-MM-DD"),
    ],
  },
  {
    testRegex: /^([0-9-T:]+)$/,
    deserialize: (matches, fieldRef) => ["=", fieldRef, matches[0]],
  },
  {
    testRegex: /^([0-9-T:]+)~([0-9-T:]+)$/,
    deserialize: (matches, fieldRef) => [
      "between",
      fieldRef,
      matches[0],
      matches[1],
    ],
  },
];

export function dateParameterValueToMBQL(
  parameterValue: ParameterValue,
  fieldRef: LocalFieldReference | ForeignFieldReference,
): ?FieldFilter {
  const deserializer: ?Deserializer = timeParameterValueDeserializers.find(
    des => des.testRegex.test(parameterValue),
  );

  if (deserializer) {
    const substringMatches = deserializer.testRegex
      .exec(parameterValue)
      .splice(1);
    return deserializer.deserialize(substringMatches, fieldRef);
  } else {
    return null;
  }
}

export function stringParameterValueToMBQL(
  parameter: Parameter,
  fieldRef: LocalFieldReference | ForeignFieldReference,
): ?FieldFilter {
  const parameterValue: ParameterValueOrArray = parameter.value;
  const subtype = getParameterSubType(parameter);
  const operatorName = getParameterOperatorName(subtype);

  return [operatorName, fieldRef].concat(parameterValue);
}

export function numberParameterValueToMBQL(
  parameter: ParameterInstance,
  fieldRef: LocalFieldReference | ForeignFieldReference,
): ?FieldFilter {
  const parameterValue: ParameterValue = parameter.value;
  const subtype = getParameterSubType(parameter);
  const operatorName = getParameterOperatorName(subtype);

  return [operatorName, fieldRef].concat(
    [].concat(parameterValue).map(v => parseFloat(v)),
  );
}

function isDateParameter(parameter) {
  const type = getParameterType(parameter);
  return type === "date";
}

/** compiles a parameter with value to an MBQL clause */
export function parameterToMBQLFilter(
  parameter: ParameterInstance,
  metadata: Metadata,
): ?FieldFilter {
  if (
    !parameter.target ||
    !isDimensionTarget(parameter.target) ||
    !Array.isArray(parameter.target[1]) ||
    TemplateTagDimension.isTemplateTagClause(parameter.target[1])
  ) {
    return null;
  }

  const dimension = Dimension.parseMBQL(parameter.target[1], metadata);
  const field = dimension.field();
  const fieldRef = dimension.mbql();

  if (isDateParameter(parameter)) {
    return dateParameterValueToMBQL(parameter.value, fieldRef);
  } else if (field.isNumeric()) {
    return numberParameterValueToMBQL(parameter, fieldRef);
  } else {
    return stringParameterValueToMBQL(parameter, fieldRef);
  }
}

export function getParameterIconName(parameter: ?Parameter) {
  const type = getParameterType(parameter);
  switch (type) {
    case "date":
      return "calendar";
    case "location":
      return "location";
    case "category":
      return "string";
    case "number":
      return "number";
    case "id":
    default:
      return "label";
  }
}

export function buildHiddenParametersSlugSet(hiddenParameterSlugs) {
  return _.isString(hiddenParameterSlugs)
    ? new Set(hiddenParameterSlugs.split(","))
    : new Set();
}

export function getVisibleParameters(parameters, hiddenParameterSlugs) {
  const hiddenParametersSlugSet = buildHiddenParametersSlugSet(
    hiddenParameterSlugs,
  );

  return parameters.filter(p => !hiddenParametersSlugSet.has(p.slug));
}
